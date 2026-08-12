import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import Soup from "gi://Soup?version=3.0"
import { trackHttp, connect, timeoutAddSeconds, sourceRemove } from "./metrics"

// One Soup-backed JSON client for the token-authenticated providers
// (GitHub, Todoist). The Google services go through lib/googleAuth's
// `googleRequest` instead — they need the OAuth refresh dance, not a
// static header.
//
// The rule this centralizes is a security one, which is why it is worth
// a module rather than a copy per provider: NEVER log anything beyond
// method, path and status. Headers carry bearer tokens and bodies carry
// account data, so a `console.warn(reply)` added in a hurry to debug one
// provider would put a personal access token in the journal.

/** the shell's User-Agent; GitHub 403s requests without one */
export const USER_AGENT = "wam-shell (https://github.com/LeadSeason/wam-shell)"

export interface JsonReply {
    /** 2xx, or one of the client's extra `okStatuses` */
    ok: boolean
    /** 0 means the request never reached a server */
    status: number
    /** parsed body, null when absent or not JSON */
    json: any
    /** a response header, "" when absent (GitHub's Last-Modified) */
    header(name: string): string
}

export interface JsonClientOptions {
    /** prefixed to every path */
    baseUrl: string
    /** log prefix; also the name in the one warning this emits */
    logTag: string
    /** evaluated per request, so a rotated token is picked up */
    headers: () => Record<string, string>
    /** seconds; the provider polls, so a hung request must not outlive its interval */
    timeout?: number
    /**
     * statuses that are a successful outcome despite not being 2xx.
     * GitHub's conditional requests answer 304 for "nothing changed",
     * which is the good case and must not read as a failed poll
     */
    okStatuses?: number[]
}

/**
 * Cap on a response body, in bytes.
 *
 * `send_and_read_async` buffers the WHOLE body before the callback runs,
 * so without a cap a broken or hostile endpoint decides how much memory
 * the shell allocates. Every one of these providers answers in tens of
 * kilobytes; 8 MB is far past any legitimate reply and still small
 * enough to be harmless. coverArt has had this for images all along —
 * the JSON clients simply never grew it.
 */
export const MAX_BODY_BYTES = 8 * 1024 * 1024

export function createJsonClient(opts: JsonClientOptions) {
    // Soup's `timeout` is an IDLE timeout, not a deadline: a response
    // that dribbles one byte before each interval elapses never trips
    // it, and the provider's `pollInFlight`-style guards then stay set
    // forever. The per-request watchdog below is the actual deadline.
    const timeoutSec = opts.timeout ?? 20
    const session = new Soup.Session({ timeout: timeoutSec })
    const extraOk = new Set(opts.okStatuses ?? [])

    /**
     * @param path appended to baseUrl, already encoded
     * @param extraHeaders per-request additions (If-Modified-Since)
     */
    return function request(
        method: string,
        path: string,
        cb: (r: JsonReply) => void,
        extraHeaders: Record<string, string> = {},
    ) {
        const url = `${opts.baseUrl}${path}`
        const msg = Soup.Message.new(method, url)
        const fail = (status: number): JsonReply => ({
            ok: false,
            status,
            json: null,
            header: () => "",
        })
        // a url Soup refuses to parse yields no message at all
        if (!msg) return cb(fail(0))

        const h = msg.get_request_headers()
        for (const [k, v] of Object.entries({ ...opts.headers(), ...extraHeaders })) {
            if (v) h.append(k, v)
        }

        // one deadline per request. Cancelling is what makes the callback
        // run (with an error) instead of never running at all, so the
        // caller's promise/flag always settles
        const cancellable = new Gio.Cancellable()
        let timedOut = false

        // Refuse an oversized body BEFORE it is buffered. This has to
        // hang off got-headers: response headers do not exist until the
        // response starts arriving, so reading Content-Length next to the
        // send call reads an empty header list and always sees 0.
        // Cancelling here aborts the transfer mid-flight. The byte check
        // in the callback stays as the real enforcement — Content-Length
        // is a claim, and a chunked response makes none at all
        connect(msg, "got-headers", () => {
            const declared = Number(msg.get_response_headers().get_one("Content-Length")) || 0
            if (declared > MAX_BODY_BYTES) cancellable.cancel()
        })
        const deadline = timeoutAddSeconds(
            "httpJson:deadline",
            GLib.PRIORITY_DEFAULT,
            // generous relative to the idle timeout: this is the backstop
            // for a request that is technically progressing, not the
            // normal failure path
            timeoutSec * 3,
            () => {
                timedOut = true
                cancellable.cancel()
                return GLib.SOURCE_REMOVE
            },
        )

        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (_s, res) => {
            if (!timedOut) sourceRemove(deadline)
            let reply: JsonReply
            try {
                const bytes = session.send_and_read_finish(res)
                const size = bytes?.get_size() ?? 0
                if (bytes) trackHttp(url, size)
                if (size > MAX_BODY_BYTES) {
                    throw new Error(`response body over ${MAX_BODY_BYTES} bytes`)
                }
                const text = bytes
                    ? new TextDecoder().decode(bytes.get_data() ?? new Uint8Array())
                    : ""
                let json: any = null
                try {
                    json = text ? JSON.parse(text) : null
                } catch {} // a non-JSON body is a null body, not a throw
                const status = msg.get_status()
                reply = {
                    ok: (status >= 200 && status < 300) || extraOk.has(status),
                    status,
                    json,
                    header: name => msg.get_response_headers().get_one(name) ?? "",
                }
            } catch {
                reply = fail(0)
            }
            // path only, and only up to the query string: a token can
            // ride in a query parameter and must not reach the log
            if (!reply.ok) {
                console.warn(
                    `${opts.logTag}: ${method} ${path.split("?")[0]} -> ${reply.status || "network error"}`,
                )
            }
            cb(reply)
        })
    }
}
