import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import Soup from "gi://Soup?version=3.0"
import Config from "../../config"
import { loadCredentials as loadEnvCredentials } from "../credentials"
import { configHome } from "../paths"
import { MAX_BODY_BYTES } from "../httpJson"
import { timeoutAddSeconds, sourceRemove, trackHttp, connect } from "../metrics"

// HTTP plumbing + the credential gate every other harvest module
// imports. Nothing here owns sync state: callers decide what a reply
// means. disposeHttp() cancels in-flight requests and pending retries

const BASE = "https://api.harvestapp.com/v2"
// Harvest 400s requests without a User-Agent
const UA = "wam-shell (https://github.com/LeadSeason/wam-shell)"

// ---------------------------------------------------------- credentials

interface Credentials {
    token: string
    accountId: string
}

function loadCredentials(): Credentials | null {
    const path = `${configHome}/harvest.env`
    const env = loadEnvCredentials("Harvest", ["HARVEST_TOKEN", "HARVEST_ACCOUNT_ID"], path)
    return env ? { token: env.HARVEST_TOKEN, accountId: env.HARVEST_ACCOUNT_ID } : null
}

const creds = Config.harvest.enabled ? loadCredentials() : null
// widgets gate on this: enabled + credentials present
export const active = Config.harvest.enabled && creds !== null
if (Config.harvest.enabled && !creds) {
    console.log(
        "Harvest: enabled but no credentials (env HARVEST_TOKEN/HARVEST_ACCOUNT_ID or ~/.config/wam-shell/harvest.env); widget disabled",
    )
}

// ---------------------------------------------------------------- http

const SESSION_TIMEOUT_SEC = 20
const session = new Soup.Session({ timeout: SESSION_TIMEOUT_SEC })
// in-flight HTTP cancellables so disposeHttp() can actually stop the
// module (a late response must not re-arm polling after teardown)
const inFlightCancellables = new Set<Gio.Cancellable>()

export interface Reply {
    ok: boolean // 2xx with parseable body (or no body needed)
    authFailed: boolean // 401/403
    status: number
    json: any
    retryAfter: number // seconds, from 429 responses (0 = absent)
}

// never log anything beyond method + path + status: headers carry the token
export function request(method: string, path: string, body: any, cb: (r: Reply) => void) {
    const url = `${BASE}${path}`
    const msg = Soup.Message.new(method, url)
    if (!msg) {
        cb({
            ok: false,
            authFailed: false,
            status: 0,
            json: null,
            retryAfter: 0,
        })
        return
    }
    const h = msg.get_request_headers()
    h.append("Authorization", `Bearer ${creds!.token}`)
    h.append("Harvest-Account-Id", creds!.accountId)
    h.append("User-Agent", UA)
    if (body !== null && body !== undefined) {
        const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body)))
        msg.set_request_body_from_bytes("application/json", bytes)
    }
    const cancellable = new Gio.Cancellable()
    inFlightCancellables.add(cancellable)
    // same two guards as googleAuth's googleRequest, and for the same
    // reasons: send_and_read buffers the whole body before the callback
    // runs, and Soup's session `timeout` is an IDLE timeout rather than
    // a deadline — a response trickling a byte every <20s would
    // otherwise never complete (deltaInFlight stuck true, the delta
    // loop silently dead until restart). got-headers, not a read next
    // to the send: the response headers do not exist yet at that point
    let timedOut = false
    connect(msg, "got-headers", () => {
        const declared = Number(msg.get_response_headers().get_one("Content-Length")) || 0
        if (declared > MAX_BODY_BYTES) cancellable.cancel()
    })
    const deadline = timeoutAddSeconds(
        "harvest:deadline",
        GLib.PRIORITY_DEFAULT,
        SESSION_TIMEOUT_SEC * 3,
        () => {
            timedOut = true
            cancellable.cancel()
            return GLib.SOURCE_REMOVE
        },
    )
    session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (_s, res) => {
        inFlightCancellables.delete(cancellable)
        if (!timedOut) sourceRemove(deadline)
        let reply: Reply
        try {
            const bytes = session.send_and_read_finish(res)
            const size = bytes?.get_size() ?? 0
            if (bytes) trackHttp(url, size)
            if (size > MAX_BODY_BYTES) {
                throw new Error(`response body over ${MAX_BODY_BYTES} bytes`)
            }
            const text = bytes ? new TextDecoder().decode(bytes.get_data() ?? new Uint8Array()) : ""
            let json: any = null
            try {
                json = text ? JSON.parse(text) : null
            } catch {}
            const status = msg.get_status()
            const retryAfter =
                status === 429 ? Number(msg.get_response_headers().get_one("Retry-After")) || 0 : 0
            reply = {
                ok: status >= 200 && status < 300,
                // 401 = bad token; 403 is a permissions answer (e.g.
                // /company for non-admins), not an auth failure
                authFailed: status === 401,
                status,
                json,
                retryAfter,
            }
        } catch (e) {
            reply = {
                ok: false,
                authFailed: false,
                status: 0,
                json: null,
                retryAfter: 0,
            }
        }
        if (!reply.ok && !reply.authFailed) {
            console.warn(`Harvest: ${method} ${path} -> ${reply.status || "network error"}`)
        }
        cb(reply)
    })
}

// pending 429 retries (fetchAll chains run concurrently): tracked so
// disposeHttp() can cancel them all
const fetchRetrySources = new Set<number>()

// follow links.next until exhausted (cursor- and page-based endpoints alike)
export function fetchAll(
    path: string,
    key: string,
    acc: any[],
    cb: (items: any[] | null, r: Reply) => void,
    retried = false,
) {
    request("GET", path, null, r => {
        // one bounded retry on throttle: a 429 would otherwise silently
        // abandon the whole slow fetch. Sources are tracked per chain
        // (chains run concurrently — a single global id would let one
        // chain cancel another's retry) so disposeHttp() can cancel them
        if (r.status === 429 && !retried) {
            const src = timeoutAddSeconds(
                "harvest:fetchRetry",
                GLib.PRIORITY_DEFAULT,
                Math.max(r.retryAfter, 1),
                () => {
                    fetchRetrySources.delete(src)
                    fetchAll(path, key, acc, cb, true)
                    return GLib.SOURCE_REMOVE
                },
            )
            fetchRetrySources.add(src)
            return
        }
        if (!r.ok || !r.json) {
            cb(r.ok ? acc : null, r)
            return
        }
        const items = acc.concat(r.json[key] ?? [])
        const next: string | null = r.json.links?.next ?? null
        if (next && next.startsWith(BASE)) fetchAll(next.slice(BASE.length), key, items, cb)
        else cb(items, r)
    })
}

export function disposeHttp() {
    for (const c of inFlightCancellables) c.cancel()
    inFlightCancellables.clear()
    for (const src of fetchRetrySources) sourceRemove(src)
    fetchRetrySources.clear()
}
