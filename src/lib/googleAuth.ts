import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import Soup from "gi://Soup?version=3.0"
import { Accessor, createState } from "gnim"
import { isFile } from "./utils"
import { timeoutAddSeconds, sourceRemove, trackHttp } from "./metrics"

// Shared Google OAuth2 for wam-shell's Google providers (calendar,
// YouTube, …). One embedded desktop client serves every service and
// every account: each consumer gets a factory instance with its own
// token store and scope; the consent flow is the installed-app loopback
// redirect (RFC 8252), one sign-in per Google account.
//
// Hard-won details, kept deliberately: Gio.Socket.new positional ctor
// (the object form yields an uninitialized socket), ONE stable consent
// page per flow (re-clicking re-opens the same page — a flow per click
// sprinkles tabs pointing at dead ports), the accept callback captures
// its own listener (a torn-down flow's pending accept must not fire
// against the new one), and accept_finish returns a TUPLE in GJS.

const OAUTH = "https://oauth2.googleapis.com/token"
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"

// project-owned OAuth desktop client: the zero-setup default. Google
// treats installed-app client secrets as non-confidential (their own
// docs say so), so embedding is expected practice — a personal
// google.env or the env vars still override it
const DEFAULT_CLIENT_ID = "596900825927-n0jv9hjsjcfb3nk8isvc74f13ji709v2.apps.googleusercontent.com"
const DEFAULT_CLIENT_SECRET = "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"

export interface GoogleAccount {
    email: string // identity label from the service (email, channel title)
    refresh_token: string
    access_token: string
    expires_at: number // ms epoch
}

interface Credentials {
    clientId: string
    clientSecret: string
}

export interface Reply {
    ok: boolean
    status: number
    json: any
}

const configHome = `${GLib.getenv("XDG_CONFIG_HOME") || `${GLib.getenv("HOME")}/.config`}/wam-shell`
const envPath = `${configHome}/google.env`

function warnPerms(logTag: string, path: string) {
    try {
        const info = Gio.File.new_for_path(path).query_info(
            "unix::mode",
            Gio.FileQueryInfoFlags.NONE,
            null,
        )
        const mode = info.get_attribute_uint32("unix::mode") & 0o777
        if (mode & 0o077) {
            console.warn(
                `${logTag}: ${path} is readable by group/other (mode ${mode.toString(8)}); consider chmod 600`,
            )
        }
    } catch (e) {
        console.warn(`${logTag}: could not stat file:`, e)
    }
}

// precedence: env vars > google.env > the embedded project client
function loadCredentials(): Credentials | null {
    const envId = GLib.getenv("GOOGLE_CLIENT_ID")
    const envSecret = GLib.getenv("GOOGLE_CLIENT_SECRET")
    if (envId && envSecret) return { clientId: envId, clientSecret: envSecret }

    if (isFile(envPath)) {
        // documented chmod 600 is advice; warn when group/other can read it
        warnPerms("GoogleAuth", envPath)

        let clientId = "",
            clientSecret = ""
        try {
            const contents = GLib.file_get_contents(envPath)[1]
            const text = new TextDecoder().decode(contents)
            for (const line of text.split("\n")) {
                const m = line.match(
                    /^\s*(?:export\s+)?(GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET)\s*=\s*(.+?)\s*$/,
                )
                if (!m) continue
                // tolerate inline comments and single/double quotes
                const value = m[2].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "")
                if (m[1] === "GOOGLE_CLIENT_ID") clientId = value
                else clientSecret = value
            }
        } catch (e) {
            console.warn("GoogleAuth: failed reading credentials file:", e)
        }
        if (clientId && clientSecret) return { clientId, clientSecret }
    }

    if (DEFAULT_CLIENT_ID && DEFAULT_CLIENT_SECRET) {
        return { clientId: DEFAULT_CLIENT_ID, clientSecret: DEFAULT_CLIENT_SECRET }
    }
    return null
}

const session = new Soup.Session({ timeout: 20 })

// shared HTTP for the OAuth endpoints AND consumer API calls. never
// log anything beyond method + url + status: headers/bodies carry
// tokens and client secrets
export function googleRequest(
    method: string,
    url: string,
    opts: { bearer?: string; form?: Record<string, string> },
    cb: (r: Reply) => void,
) {
    const msg = Soup.Message.new(method, url)
    if (!msg) {
        cb({ ok: false, status: 0, json: null })
        return
    }
    if (opts.bearer) msg.get_request_headers().append("Authorization", `Bearer ${opts.bearer}`)
    if (opts.form) {
        const body = Object.entries(opts.form)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join("&")
        const bytes = new GLib.Bytes(new TextEncoder().encode(body))
        msg.set_request_body_from_bytes("application/x-www-form-urlencoded", bytes)
    }
    session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (_s, res) => {
        let reply: Reply
        try {
            const bytes = session.send_and_read_finish(res)
            if (bytes) trackHttp(url, bytes.get_size())
            const text = bytes ? new TextDecoder().decode(bytes.get_data() ?? new Uint8Array()) : ""
            let json: any = null
            try {
                json = text ? JSON.parse(text) : null
            } catch {}
            const status = msg.get_status()
            reply = { ok: status >= 200 && status < 300, status, json }
        } catch (e) {
            reply = { ok: false, status: 0, json: null }
        }
        cb(reply)
    })
}

export interface GoogleAuth {
    active: boolean
    // identity labels of the signed-in accounts (UI state)
    accounts: Accessor<string[]>
    // full account records, for the consumer's sync loop
    getAccounts(): GoogleAccount[]
    authBusy: Accessor<boolean>
    authenticate(): void
    ensureAccessToken(account: GoogleAccount, cb: (token: string | null) => void): void
    // a revoked refresh token drops one account; consumers clear their
    // own state for it
    onAccountRemoved(fn: (email: string) => void): void
    // fired when a sign-in lands — consumers that idle while signed out
    // (no timers of their own) start their work here
    onAccountAdded(fn: (email: string) => void): void
    dispose(): void
}

export function createGoogleAuth(opts: {
    scope: string
    tokensPath: string
    logTag: string
    enabled: boolean
    // learn who just signed in, using a fresh access token;
    // cb(null) = could not identify (the account is not stored)
    identify: (accessToken: string, cb: (email: string | null) => void) => void
}): GoogleAuth {
    const { scope, tokensPath, logTag, enabled, identify } = opts

    const creds = enabled ? loadCredentials() : null
    const active = enabled && creds !== null
    if (enabled && !creds) {
        console.log(
            `${logTag}: enabled but no credentials (env GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET or ~/.config/wam-shell/google.env); feature stays off`,
        )
    }

    // ---------------------------------------------------------- tokens

    let accounts: GoogleAccount[] = []
    const [accountEmails, setAccountEmails] = createState<string[]>([])
    const removedCallbacks: ((email: string) => void)[] = []
    const addedCallbacks: ((email: string) => void)[] = []

    function loadTokens() {
        if (!isFile(tokensPath)) return
        warnPerms(logTag, tokensPath)
        try {
            const contents = GLib.file_get_contents(tokensPath)[1]
            const t = JSON.parse(new TextDecoder().decode(contents))
            if (Array.isArray(t?.accounts)) {
                accounts = t.accounts.filter(
                    (a: any) => a?.refresh_token && typeof a?.access_token === "string",
                )
            }
        } catch (e) {
            console.warn(`${logTag}: failed reading tokens:`, e)
        }
    }

    // never log the contents: the tokens are secrets
    function storeTokens() {
        try {
            GLib.file_set_contents(tokensPath, JSON.stringify({ accounts }))
        } catch (e) {
            console.warn(`${logTag}: failed writing tokens:`, e)
        }
    }

    function removeAccount(email: string) {
        accounts = accounts.filter(a => a.email !== email)
        storeTokens()
        setAccountEmails(accounts.map(a => a.email))
        console.warn(
            `${logTag}: account ${email} signed out (refresh token rejected); sign in again`,
        )
        for (const fn of removedCallbacks) fn(email)
    }

    // ------------------------------------------------------- OAuth flow

    let authInProgress = false
    let authListener: Gio.SocketListener | null = null
    let authTimeout = 0
    const [authBusy, setAuthBusy] = createState(false)
    let redirectUri: string | null = null
    let authUrl = ""

    function finishAuth(ok: boolean, code?: string) {
        if (authTimeout) {
            sourceRemove(authTimeout)
            authTimeout = 0
        }
        if (authListener) {
            authListener.close()
            authListener = null
        }
        authInProgress = false
        setAuthBusy(false)
        authUrl = ""
        if (ok && code) exchangeCode(code)
    }

    function exchangeCode(code: string) {
        googleRequest(
            "POST",
            OAUTH,
            {
                form: {
                    code,
                    client_id: creds!.clientId,
                    client_secret: creds!.clientSecret,
                    redirect_uri: redirectUri!,
                    grant_type: "authorization_code",
                },
            },
            r => {
                if (!r.ok || !r.json?.refresh_token) {
                    console.warn(`${logTag}: code exchange failed (status ${r.status})`)
                    return
                }
                const account: GoogleAccount = {
                    email: "",
                    refresh_token: r.json.refresh_token,
                    access_token: r.json.access_token ?? "",
                    expires_at: Date.now() + (Number(r.json.expires_in) || 0) * 1000,
                }
                identify(account.access_token, email => {
                    if (!email) {
                        console.warn(
                            `${logTag}: signed in but could not identify the account; not storing it — try again`,
                        )
                        return
                    }
                    account.email = email
                    accounts = [...accounts.filter(a => a.email !== account.email), account]
                    storeTokens()
                    setAccountEmails(accounts.map(a => a.email))
                    console.log(`${logTag}: signed in as ${account.email}`)
                    for (const fn of addedCallbacks) fn(account.email)
                })
            },
        )
    }

    function openConsentPage() {
        Gio.AppInfo.launch_default_for_uri_async(authUrl, null, null, (_s, res) => {
            try {
                Gio.AppInfo.launch_default_for_uri_finish(res)
            } catch (e) {
                console.warn(`${logTag}: could not open the browser:`, e)
                finishAuth(false)
            }
        })
    }

    function authenticate() {
        if (!active) return
        // a flow is already waiting: just re-open the SAME consent page
        if (authInProgress) {
            openConsentPage()
            return
        }
        let port: number
        try {
            const sock = Gio.Socket.new(
                Gio.SocketFamily.IPV4,
                Gio.SocketType.STREAM,
                Gio.SocketProtocol.DEFAULT,
            )
            const loopback = Gio.InetAddress.new_loopback(Gio.SocketFamily.IPV4)
            sock.bind(new Gio.InetSocketAddress({ address: loopback, port: 0 }), false)
            port = (sock.get_local_address() as Gio.InetSocketAddress).get_port()
            sock.listen()
            authListener = new Gio.SocketListener()
            authListener.add_socket(sock, null)
        } catch (e) {
            console.warn(`${logTag}: could not start the loopback listener:`, e)
            return
        }
        authInProgress = true
        setAuthBusy(true)
        redirectUri = `http://127.0.0.1:${port}`

        // this flow's own listener, captured: a torn-down listener's
        // pending accept resolves cancelled — silently ignore it, and
        // never finish against the module's (possibly newer) listener
        const listener = authListener
        listener.accept_async(null, (_l, res) => {
            let conn: Gio.SocketConnection | null = null
            try {
                // GJS: accept_finish returns [connection, source_object]
                ;[conn] = listener.accept_finish(res) as unknown as [Gio.SocketConnection, unknown]
            } catch {
                conn = null
            }
            if (!conn) return // cancelled by teardown/timeout
            if (listener !== authListener) {
                try {
                    conn.close(null)
                } catch {}
                return
            }
            conn.get_input_stream().read_bytes_async(
                8192,
                GLib.PRIORITY_DEFAULT,
                null,
                (s, res2) => {
                    if (listener !== authListener) {
                        try {
                            conn.close(null)
                        } catch {}
                        return
                    }
                    let code: string | null = null
                    try {
                        const bytes = (s as Gio.InputStream).read_bytes_finish(res2)
                        const text = new TextDecoder().decode(bytes.get_data() ?? new Uint8Array())
                        const path = text.split("\r\n")[0]?.match(/^GET\s+(\S+)/)?.[1] ?? ""
                        code = path.match(/[?&]code=([^&\s]+)/)?.[1] ?? null
                        if (code) code = decodeURIComponent(code)
                        else console.warn(`${logTag}: redirect without a code (denied?)`)
                    } catch (e) {
                        console.warn(`${logTag}: failed reading the redirect:`, e)
                    }
                    const body = code
                        ? `<h3>wam-shell: sign-in complete</h3>You can close this tab.`
                        : "<h3>wam-shell: sign-in failed</h3>You can close this tab."
                    const http = `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`
                    try {
                        conn!
                            .get_output_stream()
                            .write_bytes(new GLib.Bytes(new TextEncoder().encode(http)), null)
                        conn!.close(null)
                    } catch {}
                    finishAuth(!!code, code ?? undefined)
                },
            )
        })

        const params = [
            `client_id=${encodeURIComponent(creds!.clientId)}`,
            `redirect_uri=${encodeURIComponent(redirectUri)}`,
            "response_type=code",
            `scope=${encodeURIComponent(scope)}`,
            "access_type=offline",
            "prompt=consent",
        ].join("&")
        authUrl = `${AUTH_URL}?${params}`
        console.log(`${logTag}: waiting for the sign-in redirect on ${redirectUri} (120s)`)
        openConsentPage()

        // don't wait (and listen) forever
        authTimeout = timeoutAddSeconds(
            "googleAuth:authTimeout",
            GLib.PRIORITY_DEFAULT,
            120,
            () => {
                authTimeout = 0
                console.warn(`${logTag}: sign-in timed out`)
                finishAuth(false)
                return GLib.SOURCE_REMOVE
            },
        )
    }

    // ----------------------------------------------------- token refresh

    const refreshInFlight = new Map<string, ((t: string | null) => void)[]>()

    function ensureAccessToken(account: GoogleAccount, cb: (token: string | null) => void) {
        if (Date.now() < account.expires_at - 60_000) return cb(account.access_token)
        const waiters = refreshInFlight.get(account.email)
        if (waiters) {
            waiters.push(cb)
            return
        }
        refreshInFlight.set(account.email, [cb])
        googleRequest(
            "POST",
            OAUTH,
            {
                form: {
                    refresh_token: account.refresh_token,
                    client_id: creds!.clientId,
                    client_secret: creds!.clientSecret,
                    grant_type: "refresh_token",
                },
            },
            r => {
                let token: string | null = null
                if (r.ok && r.json?.access_token) {
                    account.access_token = r.json.access_token
                    account.expires_at = Date.now() + (Number(r.json.expires_in) || 0) * 1000
                    storeTokens()
                    token = account.access_token
                } else if (r.status === 400 && r.json?.error === "invalid_grant") {
                    removeAccount(account.email)
                }
                const done = refreshInFlight.get(account.email) ?? []
                refreshInFlight.delete(account.email)
                for (const w of done) w(token)
            },
        )
    }

    // ------------------------------------------------------------ wiring

    if (active) {
        loadTokens()
        setAccountEmails(accounts.map(a => a.email))
    }

    return {
        active,
        accounts: accountEmails,
        getAccounts: () => [...accounts],
        authBusy,
        authenticate,
        ensureAccessToken,
        onAccountRemoved: fn => removedCallbacks.push(fn),
        onAccountAdded: fn => addedCallbacks.push(fn),
        dispose: () => {
            if (authTimeout) {
                sourceRemove(authTimeout)
                authTimeout = 0
            }
            if (authListener) {
                authListener.close()
                authListener = null
            }
            // a mid-flow dispose would otherwise leave the consumer's
            // sign-in button spinning forever
            authInProgress = false
            setAuthBusy(false)
        },
    }
}
