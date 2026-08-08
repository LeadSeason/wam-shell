import GLib from "gi://GLib?version=2.0"
import Soup from "gi://Soup?version=3.0"
import { trackHttp } from "./metrics"

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

export function createJsonClient(opts: JsonClientOptions) {
    const session = new Soup.Session({ timeout: opts.timeout ?? 20 })
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

        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (_s, res) => {
            let reply: JsonReply
            try {
                const bytes = session.send_and_read_finish(res)
                if (bytes) trackHttp(url, bytes.get_size())
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
