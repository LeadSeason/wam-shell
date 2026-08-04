import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import Soup from "gi://Soup?version=3.0"
import { Accessor, createState } from "gnim"
import { isFile } from "./utils"
import { timeoutAddSeconds, sourceRemove, trackHttp } from "./metrics"
import { writeFileAtomic } from "./atomicWrite"
import { secretsAvailable, secretStore, secretLookup, secretClear } from "./secretStore"
import { warnPerms, loadCredentials as loadEnvCredentials } from "./credentials"

// Shared Google OAuth2 for wam-shell's Google providers (calendar,
// YouTube, …). One embedded desktop client serves every service and
// every account: each consumer gets a factory instance with its own
// token store and scope; the consent flow is the installed-app loopback
// redirect (RFC 8252) with PKCE (RFC 7636) and a per-flow state nonce,
// one sign-in per Google account.
//
// Hard-won details, kept deliberately: Gio.Socket.new positional ctor
// (the object form yields an uninitialized socket), ONE stable consent
// page per flow (re-clicking re-opens the same page — a flow per click
// sprinkles tabs pointing at dead ports), the accept callback captures
// its own listener (a torn-down flow's pending accept must not fire
// against the new one), and accept_finish returns a TUPLE in GJS.
//
// The listener accepts in a LOOP: browsers open speculative connections
// (Chromium preconnect that never sends a byte, /favicon.ico) and a
// single accept would let one of those consume the whole sign-in. Only
// a request carrying code=/error= with the flow's state ends the flow
// (or the 120s timeout); anything else gets a minimal 404/400 and the
// listener keeps listening.
//
// Refresh tokens live in the Secret Service keyring when it is
// available (soft dependency, see lib/secretStore.ts) and otherwise in
// the tokens file, which is always written atomically with mode 0600.
// With a keyring the file keeps only account metadata (refresh_token
// blanked) so startup still knows the accounts offline.

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

// ------------------------------------------------------ PKCE / state
// small helpers, exported for the unit tests (no network involved)

// /dev/urandom via Gio: GLib.random_* is a seeded PRNG, NOT a CSPRNG
function csprngBytes(n: number): Uint8Array {
    const stream = Gio.File.new_for_path("/dev/urandom").read(null)
    try {
        const data = stream.read_bytes(n, null).get_data()
        if (!data || data.length < n) {
            throw new Error(`short /dev/urandom read (${data?.length ?? 0}/${n})`)
        }
        return data
    } finally {
        stream.close(null)
    }
}

function base64url(data: Uint8Array): string {
    return GLib.base64_encode(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

// RFC 7636: base64url of 32 random bytes = 43 chars (the spec minimum)
export function generateCodeVerifier(): string {
    return base64url(csprngBytes(32))
}

// base64url(SHA256(verifier)); the gjs Checksum binding exposes only
// the hex digest, so convert ASCII hex back to bytes
export function pkceChallenge(verifier: string): string {
    const sum = new GLib.Checksum(GLib.ChecksumType.SHA256)
    sum.update(new TextEncoder().encode(verifier))
    const hex = sum.get_string()
    const digest = new Uint8Array(hex.length / 2)
    for (let i = 0; i < digest.length; i++) digest[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    return base64url(digest)
}

// CSRF nonce for the redirect round-trip
export function generateState(): string {
    return base64url(csprngBytes(24))
}

// the nonce must come back exactly; a missing or different state is not
// our redirect and must never end the flow
export function stateMatches(expected: string, got: string | null): boolean {
    return got !== null && got === expected
}

export function buildAuthUrl(opts: {
    clientId: string
    redirectUri: string
    scope: string
    state: string
    codeChallenge: string
}): string {
    const params = [
        `client_id=${encodeURIComponent(opts.clientId)}`,
        `redirect_uri=${encodeURIComponent(opts.redirectUri)}`,
        "response_type=code",
        `scope=${encodeURIComponent(opts.scope)}`,
        "access_type=offline",
        "prompt=consent",
        `state=${encodeURIComponent(opts.state)}`,
        // base64url needs no percent-encoding
        `code_challenge=${opts.codeChallenge}`,
        "code_challenge_method=S256",
    ].join("&")
    return `${AUTH_URL}?${params}`
}

// the request target of a loopback request ("GET <target> HTTP/1.1"),
// null for non-GET garbage
export function requestTarget(requestText: string): string | null {
    const line = requestText.split("\r\n", 1)[0] ?? ""
    return line.match(/^GET\s+(\S+)/)?.[1] ?? null
}

export interface RedirectParams {
    code: string | null
    error: string | null
    state: string | null
}

export function parseRedirectParams(target: string): RedirectParams {
    const out: RedirectParams = { code: null, error: null, state: null }
    const q = target.indexOf("?")
    if (q < 0) return out
    for (const pair of target.slice(q + 1).split("&")) {
        const eq = pair.indexOf("=")
        if (eq <= 0) continue
        const key = pair.slice(0, eq)
        if (key !== "code" && key !== "error" && key !== "state") continue
        try {
            // empty values stay null: "?code=" is junk, not a redirect
            const value = decodeURIComponent(pair.slice(eq + 1))
            if (value) out[key] = value
        } catch {
            // malformed percent-encoding: treat as absent
        }
    }
    return out
}

// ------------------------------------------------------------- module

// token files written by older shells were 0666 & ~umask: migrate
// anything wider than 0600 in place (warnPerms still tells the user it
// happened)
function enforcePrivatePerms(logTag: string, path: string) {
    try {
        const file = Gio.File.new_for_path(path)
        const info = file.query_info("unix::mode", Gio.FileQueryInfoFlags.NONE, null)
        const mode = info.get_attribute_uint32("unix::mode") & 0o777
        if (mode & 0o077) {
            file.set_attribute_uint32("unix::mode", 0o600, Gio.FileQueryInfoFlags.NONE, null)
            console.warn(`${logTag}: migrated ${path} from mode ${mode.toString(8)} to 600`)
        }
    } catch (e) {
        console.warn(`${logTag}: could not fix ${path} permissions:`, e)
    }
}

// precedence: env vars > google.env > the embedded project client
function loadCredentials(): Credentials | null {
    const env = loadEnvCredentials(
        "GoogleAuth",
        ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
        envPath,
    )
    if (env) return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }

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
    // keyring service id from the token file: gcal-tokens.json -> gcal
    const serviceId = GLib.path_get_basename(tokensPath).replace(/-tokens\.json$/, "")

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

    // accounts whose refresh token lives only in the keyring load from
    // the file with refresh_token = ""; each gets a fill promise that
    // ensureAccessToken waits on. Registered synchronously at load, so
    // a refresh can never slip through before the probe resolves (an
    // empty token would earn a spurious invalid_grant and drop the
    // account)
    const fillWaiters = new Map<string, Promise<void>>()

    function loadTokens() {
        if (!isFile(tokensPath)) return
        warnPerms(logTag, tokensPath)
        enforcePrivatePerms(logTag, tokensPath)
        try {
            const contents = GLib.file_get_contents(tokensPath)[1]
            const t = JSON.parse(new TextDecoder().decode(contents))
            if (Array.isArray(t?.accounts)) {
                // refresh_token may be "" (keyring-backed file): require
                // the field, not its truthiness
                accounts = t.accounts.filter(
                    (a: any) =>
                        typeof a?.email === "string" &&
                        typeof a?.refresh_token === "string" &&
                        typeof a?.access_token === "string",
                )
            }
        } catch (e) {
            console.warn(`${logTag}: failed reading tokens:`, e)
        }
        for (const a of accounts) {
            if (a.refresh_token) continue
            const fill = (async () => {
                try {
                    const token = await secretLookup(serviceId, a.email)
                    if (token) a.refresh_token = token
                    // no entry (keyring cleared, migrated away): the
                    // next refresh fails with invalid_grant and the
                    // account is dropped with a re-sign-in hint —
                    // self-healing, no special case here
                } finally {
                    fillWaiters.delete(a.email)
                }
            })()
            fillWaiters.set(a.email, fill)
        }
        if (accounts.some(a => a.refresh_token)) void migrateToKeyring()
    }

    // one-shot: plaintext refresh tokens found in the file move into
    // the keyring, then the file is rewritten WITHOUT them. The file
    // itself stays (account metadata + short-lived access tokens, the
    // offline fallback shape every writer uses) — deleting it would
    // lose the account list on sessions where the keyring is gone
    async function migrateToKeyring() {
        if (!(await secretsAvailable())) return
        let moved = 0
        for (const a of accounts) {
            if (a.refresh_token && (await secretStore(serviceId, a.email, a.refresh_token))) {
                moved++
            }
        }
        if (moved === 0) return
        console.log(`${logTag}: moved ${moved} refresh token(s) into the Secret Service keyring`)
        storeTokens()
    }

    // serialized so concurrent writers (sign-in, refresh, removal,
    // migration) can never interleave their async keyring+file steps;
    // each run reads the live accounts array when its turn comes
    let persistChain: Promise<void> = Promise.resolve()

    // never log the contents: the tokens are secrets
    function storeTokens() {
        persistChain = persistChain.then(persistTokens, persistTokens)
    }

    async function persistTokens() {
        try {
            const keyring = await secretsAvailable()
            if (keyring) {
                for (const a of accounts) {
                    if (a.refresh_token) await secretStore(serviceId, a.email, a.refresh_token)
                }
            }
            // with a keyring the file carries no refresh tokens (the
            // keyring is the secret store); without one the file holds
            // everything, at 0600 either way
            const records = accounts.map(a => (keyring ? { ...a, refresh_token: "" } : a))
            await writeFileAtomic(tokensPath, JSON.stringify({ accounts: records }), {
                private: true,
            })
        } catch (e) {
            console.warn(`${logTag}: failed writing tokens:`, e)
        }
    }

    function removeAccount(email: string) {
        accounts = accounts.filter(a => a.email !== email)
        storeTokens()
        void secretClear(serviceId, email)
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
    // per-flow PKCE verifier + state nonce (one flow at a time, guarded
    // by authInProgress)
    let pendingVerifier = ""
    let pendingState = ""

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
        const verifier = pendingVerifier
        pendingVerifier = ""
        pendingState = ""
        if (ok && code) exchangeCode(code, verifier)
    }

    function exchangeCode(code: string, verifier: string) {
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
                    code_verifier: verifier,
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

    // ---------------------------------------------------- accept loop

    // a whole request head is small; the cap only guards against junk
    const MAX_REQUEST_BYTES = 16 * 1024

    function respondAndClose(conn: Gio.SocketConnection, status: string, body: string) {
        // Content-Length counts UTF-8 BYTES, not UTF-16 code units
        const payload = new TextEncoder().encode(body)
        const head =
            `HTTP/1.1 ${status}\r\n` +
            `Content-Type: text/html; charset=utf-8\r\n` +
            `Content-Length: ${payload.length}\r\n` +
            `Connection: close\r\n\r\n`
        try {
            const headBytes = new TextEncoder().encode(head)
            const out = new Uint8Array(headBytes.length + payload.length)
            out.set(headBytes, 0)
            out.set(payload, headBytes.length)
            conn.get_output_stream().write_bytes(new GLib.Bytes(out), null)
            conn.close(null)
        } catch {}
    }

    // every accepted connection is read on its own while the listener
    // immediately re-accepts: a preconnect that never sends a byte must
    // not starve the real redirect behind it
    function acceptLoop(listener: Gio.SocketListener) {
        listener.accept_async(null, (_l, res) => {
            let conn: Gio.SocketConnection | null = null
            try {
                // GJS: accept_finish returns [connection, source_object]
                ;[conn] = listener.accept_finish(res) as unknown as [Gio.SocketConnection, unknown]
            } catch {
                conn = null
            }
            if (!conn) return // torn down by finishAuth/dispose: stop looping
            acceptLoop(listener)
            readRequest(listener, conn)
        })
    }

    // accumulate until end-of-headers (\r\n\r\n) or the cap: a single
    // fixed-size read is not guaranteed to hold the request line
    function readRequest(listener: Gio.SocketListener, conn: Gio.SocketConnection) {
        const chunks: Uint8Array[] = []
        let total = 0
        const readMore = () => {
            if (listener !== authListener) {
                try {
                    conn.close(null)
                } catch {}
                return
            }
            conn.get_input_stream().read_bytes_async(
                4096,
                GLib.PRIORITY_DEFAULT,
                null,
                (s, res) => {
                    if (listener !== authListener) {
                        try {
                            conn.close(null)
                        } catch {}
                        return
                    }
                    let data: Uint8Array | null = null
                    try {
                        data = (s as Gio.InputStream).read_bytes_finish(res).get_data() ?? null
                    } catch {
                        data = null
                    }
                    if (!data || data.length === 0) {
                        // EOF with nothing (or only a partial head): a
                        // preconnect that closed, or the peer gave up —
                        // nothing to answer
                        try {
                            conn.close(null)
                        } catch {}
                        return
                    }
                    chunks.push(data)
                    total += data.length
                    // decoded for the delimiter search only; ASCII
                    // delimiters survive a split multibyte sequence
                    const merged = new Uint8Array(total)
                    let off = 0
                    for (const c of chunks) {
                        merged.set(c, off)
                        off += c.length
                    }
                    const text = new TextDecoder().decode(merged)
                    if (!text.includes("\r\n\r\n") && total < MAX_REQUEST_BYTES) {
                        readMore()
                        return
                    }
                    processRequest(conn, text)
                },
            )
        }
        readMore()
    }

    function processRequest(conn: Gio.SocketConnection, text: string) {
        const target = requestTarget(text)
        const params = target ? parseRedirectParams(target) : null
        if (!params || (!params.code && !params.error)) {
            // favicon, a stray GET /, non-GET junk: not the redirect —
            // answer minimally and keep listening
            respondAndClose(conn, "404 Not Found", "<h3>wam-shell: not the sign-in redirect</h3>")
            return
        }
        if (!stateMatches(pendingState, params.state)) {
            // missing or foreign state: NEVER end the flow on it
            console.warn(`${logTag}: redirect with a missing or mismatched state; ignoring`)
            respondAndClose(conn, "400 Bad Request", "<h3>wam-shell: bad sign-in state</h3>")
            return
        }
        if (params.error) {
            console.warn(`${logTag}: sign-in denied (${params.error})`)
            respondAndClose(
                conn,
                "200 OK",
                "<h3>wam-shell: sign-in failed</h3>You can close this tab.",
            )
            finishAuth(false)
            return
        }
        respondAndClose(
            conn,
            "200 OK",
            "<h3>wam-shell: sign-in complete</h3>You can close this tab.",
        )
        finishAuth(true, params.code!)
    }

    // -------------------------------------------------------- browser

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
        pendingVerifier = generateCodeVerifier()
        pendingState = generateState()

        // this flow's own listener, captured: a torn-down listener's
        // pending accept resolves cancelled — silently ignore it, and
        // never finish against the module's (possibly newer) listener
        const listener = authListener
        acceptLoop(listener)

        authUrl = buildAuthUrl({
            clientId: creds!.clientId,
            redirectUri,
            scope,
            state: pendingState,
            codeChallenge: pkceChallenge(pendingVerifier),
        })
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
        // the keyring fill for this account may still be resolving:
        // wait for it instead of refreshing with an empty token
        const fill = fillWaiters.get(account.email)
        if (fill) {
            void fill.then(() => ensureAccessToken(account, cb))
            return
        }
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
