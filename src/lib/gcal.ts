import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import Soup from "gi://Soup?version=3.0"
import { createState } from "gnim"
import Config from "../config"
import { isFile } from "./utils"
import { timeoutAddSeconds, sourceRemove, trackHttp } from "./metrics"

// Google Calendar for the clock popover (Calendar API v3, read-only).
// Multiple calendars of the account are merged into one event list; the
// UI marks days on the Gtk.Calendar and lists the selected day. Auth is
// an OAuth2 installed-app flow over a loopback redirect (RFC 8252): the
// user signs in once in the browser, the refresh token lives next to
// the credentials file. Sync is a full refetch of a ~5-month window
// around the viewed month — small, quota-cheap, and stateless (no
// syncToken machinery). All date math is local; Google answers with
// UTC instants or exclusive all-day end dates, both normalized here.

const API = "https://www.googleapis.com/calendar/v3"
const OAUTH = "https://oauth2.googleapis.com/token"
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const SCOPE = "https://www.googleapis.com/auth/calendar.readonly"

// ---------------------------------------------------------------- types

export interface CalEvent {
    id: string // calendarId:googleEventId (recurring instances have unique ids)
    calendarName: string
    color: string // "#rrggbb", the calendar's backgroundColor from Google
    summary: string
    startMs: number
    endMs: number // may equal startMs (zero-length events)
    allDay: boolean
    // every local day ("YYYY-MM-DD") the event touches — marks and the
    // day list both filter on this
    days: string[]
}

interface GoogleCalendar {
    id: string
    summary: string
    color: string
}

// ---------------------------------------------------------- credentials

interface Credentials {
    clientId: string
    clientSecret: string
}

const configHome = `${GLib.getenv("XDG_CONFIG_HOME") || `${GLib.getenv("HOME")}/.config`}/wam-shell`
const envPath = `${configHome}/google.env`
const tokensPath = `${configHome}/gcal-tokens.json`
const cachePath = `${Config.instanceCacheDir}/gcal-events.json`

function warnPerms(path: string) {
    try {
        const info = Gio.File.new_for_path(path).query_info(
            "unix::mode",
            Gio.FileQueryInfoFlags.NONE,
            null,
        )
        const mode = info.get_attribute_uint32("unix::mode") & 0o777
        if (mode & 0o077) {
            console.warn(
                `GCal: ${path} is readable by group/other (mode ${mode.toString(8)}); consider chmod 600`,
            )
        }
    } catch (e) {
        console.warn("GCal: could not stat file:", e)
    }
}

function loadCredentials(): Credentials | null {
    const envId = GLib.getenv("GOOGLE_CLIENT_ID")
    const envSecret = GLib.getenv("GOOGLE_CLIENT_SECRET")
    if (envId && envSecret) return { clientId: envId, clientSecret: envSecret }

    if (!isFile(envPath)) return null

    // documented chmod 600 is advice; warn when group/other can read it
    warnPerms(envPath)

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
        console.warn("GCal: failed reading credentials file:", e)
        return null
    }
    return clientId && clientSecret ? { clientId, clientSecret } : null
}

const creds = Config.calendar.enabled ? loadCredentials() : null
// widgets gate on this: enabled + credentials present
export const active = Config.calendar.enabled && creds !== null
if (Config.calendar.enabled && !creds) {
    console.log(
        "GCal: enabled but no credentials (env GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET or ~/.config/wam-shell/google.env); calendar stays plain",
    )
}

// -------------------------------------------------------------- tokens

interface Tokens {
    refresh_token: string
    access_token: string
    expires_at: number // ms epoch
}

let tokens: Tokens | null = null

function loadTokens() {
    if (!isFile(tokensPath)) return
    warnPerms(tokensPath)
    try {
        const contents = GLib.file_get_contents(tokensPath)[1]
        const t = JSON.parse(new TextDecoder().decode(contents))
        if (t?.refresh_token && t?.access_token && t?.expires_at) tokens = t
    } catch (e) {
        console.warn("GCal: failed reading tokens:", e)
    }
}

// never log the contents: both fields are secrets
function storeTokens() {
    try {
        GLib.file_set_contents(tokensPath, JSON.stringify(tokens))
    } catch (e) {
        console.warn("GCal: failed writing tokens:", e)
    }
}

function wipeTokens() {
    tokens = null
    try {
        Gio.File.new_for_path(tokensPath).delete(null)
    } catch {} // absent is fine
}

// ---------------------------------------------------------------- state

const [authenticated, setAuthenticated] = createState(false)
export { authenticated }
// merged events of all visible calendars, sorted by startMs
const [events, setEvents] = createState<CalEvent[]>([])
export { events }

// the loaded window: navigation outside it triggers a re-sync
let loadedFrom = 0 // ms epoch, first covered day
let loadedTo = 0 // ms epoch, exclusive
let lastSyncAttempt = 0

// ------------------------------------------------------- pure helpers

// local "YYYY-MM-DD" for a ms epoch — the key marks and lists filter on
export function dayKey(ms: number): string {
    const d = new Date(ms)
    const mo = String(d.getMonth() + 1).padStart(2, "0")
    const dy = String(d.getDate()).padStart(2, "0")
    return `${d.getFullYear()}-${mo}-${dy}`
}

function localMidnight(y: number, m: number, d: number): number {
    return new Date(y, m, d).getTime()
}

// every local day an event touches. allDay ends are EXCLUSIVE per
// Google convention (a one-day event ends the next midnight); timed
// events ending exactly at midnight don't spill into that day. A
// zero-length event covers its start day only. Capped defensively: a
// broken feed must not produce 10k keys
export function eventDays(startMs: number, endMs: number, allDay: boolean): string[] {
    if (endMs <= startMs) return [dayKey(startMs)]
    const days: string[] = []
    // end is exclusive for both kinds: the last covered instant is end-1ms
    const last = new Date(endMs - 1)
    let cur = new Date(startMs)
    cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate())
    const stop = localMidnight(last.getFullYear(), last.getMonth(), last.getDate())
    for (let t = cur.getTime(); t <= stop && days.length < 62; t += 86_400_000) {
        days.push(dayKey(t))
    }
    return days
}

// normalize one Google event; null = skip (cancelled/unparseable)
export function mapGoogleEvent(
    calendarId: string,
    calendarName: string,
    color: string,
    raw: any,
): CalEvent | null {
    if (!raw || raw.status === "cancelled") return null
    const allDay = typeof raw.start?.date === "string"
    let startMs: number, endMs: number
    if (allDay) {
        // "YYYY-MM-DD" in local time; end.date is the exclusive next midnight
        const [sy, sm, sd] = raw.start.date.split("-").map(Number)
        const [ey, em, ed] = String(raw.end?.date ?? raw.start.date)
            .split("-")
            .map(Number)
        startMs = localMidnight(sy, sm - 1, sd)
        endMs = localMidnight(ey, em - 1, ed)
    } else {
        startMs = Date.parse(raw.start?.dateTime ?? "")
        endMs = Date.parse(raw.end?.dateTime ?? "")
    }
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null
    return {
        id: `${calendarId}:${raw.id ?? ""}`,
        calendarName,
        color,
        summary: raw.summary || "(no title)",
        startMs,
        endMs,
        allDay,
        days: eventDays(startMs, endMs, allDay),
    }
}

// "all day" or "HH:MM–HH:MM" for the day list
export function timeLabel(e: CalEvent): string {
    if (e.allDay) return "all day"
    const hm = (ms: number) => {
        const d = new Date(ms)
        return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    }
    return `${hm(e.startMs)}–${hm(e.endMs)}`
}

// ---------------------------------------------------------------- http

const session = new Soup.Session({ timeout: 20 })

interface Reply {
    ok: boolean
    status: number
    json: any
}

// never log anything beyond method + url + status: headers/bodies carry
// tokens and client secrets
function request(
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
        if (!reply.ok) console.warn(`GCal: ${method} ${url.split("?")[0]} -> ${reply.status || "network error"}`)
        cb(reply)
    })
}

// ----------------------------------------------------------- OAuth flow

let authInProgress = false
let authListener: Gio.SocketListener | null = null
let authTimeout = 0

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
    if (ok && code) exchangeCode(code)
}

// swap the auth code for tokens; refresh_token only appears with
// access_type=offline + prompt=consent
function exchangeCode(code: string) {
    request(
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
            if (r.ok && r.json?.refresh_token) {
                tokens = {
                    refresh_token: r.json.refresh_token,
                    access_token: r.json.access_token ?? "",
                    expires_at: Date.now() + (Number(r.json.expires_in) || 0) * 1000,
                }
                storeTokens()
                setAuthenticated(true)
                console.log("GCal: signed in")
                sync()
            } else {
                console.warn(`GCal: code exchange failed (status ${r.status})`)
            }
        },
    )
}

let redirectUri: string | null = null

// user-initiated from the popover's sign-in button: listen on a random
// loopback port, open the consent page in the browser, wait for the
// redirect carrying the code
export function authenticate() {
    if (!active || authInProgress || authenticated.get()) return
    let port: number
    try {
        const sock = new Gio.Socket(
            Gio.SocketFamily.IPV4,
            Gio.SocketType.STREAM,
            Gio.SocketProtocol.DEFAULT,
            null,
        )
        const loopback = Gio.InetAddress.new_loopback(Gio.SocketFamily.IPV4)
        sock.bind(new Gio.InetSocketAddress({ address: loopback, port: 0 }), false)
        port = (sock.get_local_address() as Gio.InetSocketAddress).get_port()
        sock.listen()
        authListener = new Gio.SocketListener()
        authListener.add_socket(sock, null)
    } catch (e) {
        console.warn("GCal: could not start the loopback listener:", e)
        return
    }
    authInProgress = true
    redirectUri = `http://127.0.0.1:${port}`

    authListener.accept_async(null, (_l, res) => {
        let conn: Gio.SocketConnection | null = null
        try {
            conn = authListener!.accept_finish(res)
        } catch {
            finishAuth(false)
            return
        }
        conn
            .get_input_stream()
            .read_bytes_async(8192, GLib.PRIORITY_DEFAULT, null, (s, res2) => {
                let code: string | null = null
                try {
                    const bytes = (s as Gio.InputStream).read_bytes_finish(res2)
                    const text = new TextDecoder().decode(bytes.get_data() ?? new Uint8Array())
                    const path = text.split("\r\n")[0]?.match(/^GET\s+(\S+)/)?.[1] ?? ""
                    code = path.match(/[?&]code=([^&\s]+)/)?.[1] ?? null
                    if (code) code = decodeURIComponent(code)
                    else console.warn("GCal: redirect without a code (denied?)")
                } catch (e) {
                    console.warn("GCal: failed reading the redirect:", e)
                }
                const body = code
                    ? "<h3>wam-shell: Google Calendar sign-in complete</h3>You can close this tab."
                    : "<h3>wam-shell: sign-in failed</h3>You can close this tab."
                const http = `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`
                try {
                    conn!
                        .get_output_stream()
                        .write_bytes(new GLib.Bytes(new TextEncoder().encode(http)), null)
                    conn!.close(null)
                } catch {}
                finishAuth(!!code, code ?? undefined)
            })
    })

    const params = [
        `client_id=${encodeURIComponent(creds!.clientId)}`,
        `redirect_uri=${encodeURIComponent(redirectUri)}`,
        "response_type=code",
        `scope=${encodeURIComponent(SCOPE)}`,
        "access_type=offline",
        "prompt=consent",
    ].join("&")
    Gio.AppInfo.launch_default_for_uri_async(`${AUTH_URL}?${params}`, null, null, (_s, res) => {
        try {
            Gio.AppInfo.launch_default_for_uri_finish(res)
        } catch (e) {
            console.warn("GCal: could not open the browser:", e)
            finishAuth(false)
        }
    })

    // don't wait (and listen) forever
    authTimeout = timeoutAddSeconds("gcal:authTimeout", GLib.PRIORITY_DEFAULT, 120, () => {
        authTimeout = 0
        console.warn("GCal: sign-in timed out")
        finishAuth(false)
        return GLib.SOURCE_REMOVE
    })
}

// access token, refreshing when stale; cb(null) = unavailable (sync
// skips, the next poll retries). Concurrent callers share one refresh
let refreshInFlight: ((t: string | null) => void)[] = []

function ensureAccessToken(cb: (token: string | null) => void) {
    if (!tokens) return cb(null)
    if (Date.now() < tokens.expires_at - 60_000) return cb(tokens.access_token)
    refreshInFlight.push(cb)
    if (refreshInFlight.length > 1) return
    request(
        "POST",
        OAUTH,
        {
            form: {
                refresh_token: tokens.refresh_token,
                client_id: creds!.clientId,
                client_secret: creds!.clientSecret,
                grant_type: "refresh_token",
            },
        },
        r => {
            let token: string | null = null
            if (r.ok && r.json?.access_token) {
                tokens!.access_token = r.json.access_token
                tokens!.expires_at = Date.now() + (Number(r.json.expires_in) || 0) * 1000
                storeTokens()
                token = tokens!.access_token
            } else if (r.status === 400 && r.json?.error === "invalid_grant") {
                // revoked/expired refresh token: back to signed-out
                console.warn("GCal: refresh token rejected; sign in again from the clock popover")
                wipeTokens()
                setAuthenticated(false)
            }
            const waiters = refreshInFlight
            refreshInFlight = []
            for (const w of waiters) w(token)
        },
    )
}

// ---------------------------------------------------------------- sync

// GET a Calendar API path with the bearer, one refresh+retry on 401
function apiGet(path: string, cb: (r: Reply) => void, retried = false) {
    ensureAccessToken(token => {
        if (!token) return cb({ ok: false, status: 401, json: null })
        request("GET", `${API}${path}`, { bearer: token }, r => {
            if (r.status === 401 && !retried) {
                // force a refresh by aging the cached token, then retry once
                if (tokens) tokens.expires_at = 0
                apiGet(path, cb, true)
                return
            }
            cb(r)
        })
    })
}

// bounded pagination: nextPageToken until exhausted (hard cap 10 pages)
function fetchPaged(
    path: string,
    key: string,
    acc: any[],
    cb: (items: any[] | null) => void,
    page = 0,
) {
    if (page >= 10) return cb(acc)
    apiGet(path, r => {
        if (!r.ok || !r.json) return cb(r.ok ? acc : null)
        const items = acc.concat(r.json[key] ?? [])
        const next: string | null = r.json.nextPageToken ?? null
        if (next) fetchPaged(`${path}&pageToken=${encodeURIComponent(next)}`, key, items, cb, page + 1)
        else cb(items)
    })
}

// [first day of focus-1mo, first day of focus+4mo): covers the 6-week
// grid around the viewed month plus a useful agenda horizon
function syncWindow(focusY: number, focusM: number): { from: number; to: number } {
    const from = new Date(focusY, focusM - 1, 1).getTime()
    const to = new Date(focusY, focusM + 4, 1).getTime()
    return { from, to }
}

let syncInFlight = false

export function sync(focus?: { y: number; m: number }) {
    if (!active || !authenticated.get() || syncInFlight) return
    syncInFlight = true
    lastSyncAttempt = Date.now()
    const now = new Date()
    const y = focus?.y ?? now.getFullYear()
    const m = focus?.m ?? now.getMonth()
    const { from, to } = syncWindow(y, m)
    const rfc3339 = (ms: number) => new Date(ms).toISOString()
    const range = `timeMin=${encodeURIComponent(rfc3339(from))}&timeMax=${encodeURIComponent(rfc3339(to))}`

    fetchPaged(`/users/me/calendarList?fields=items(id,summary,backgroundColor)`, "items", [], cals => {
        if (!cals) {
            syncInFlight = false
            return
        }
        const visible: GoogleCalendar[] = cals
            .filter((c: any) => c.id && c.summary)
            .map((c: any) => ({
                id: c.id,
                summary: c.summary,
                color: typeof c.backgroundColor === "string" ? c.backgroundColor : "#888888",
            }))
            .filter((c: GoogleCalendar) => !Config.calendar.hiddenCalendars.includes(c.summary))
        if (visible.length === 0) {
            loadedFrom = from
            loadedTo = to
            setEvents([])
            writeCache([])
            syncInFlight = false
            return
        }

        const fields = "nextPageToken,items(id,status,summary,start,end)"
        const merged: CalEvent[] = []
        let pending = visible.length
        const settle = () => {
            if (--pending > 0) return
            merged.sort((a, b) => a.startMs - b.startMs)
            loadedFrom = from
            loadedTo = to
            setEvents(merged)
            writeCache(merged)
            syncInFlight = false
        }
        for (const cal of visible) {
            const path = `/calendars/${encodeURIComponent(cal.id)}/events?${range}&singleEvents=true&maxResults=2500&fields=${encodeURIComponent(fields)}`
            fetchPaged(path, "items", [], items => {
                // a failed calendar degrades to no events for it rather
                // than poisoning the whole merge
                for (const raw of items ?? []) {
                    const e = mapGoogleEvent(cal.id, cal.summary, cal.color, raw)
                    if (e) merged.push(e)
                }
                settle()
            })
        }
    })
}

// the popover navigated to a month outside the loaded window
export function ensureCoverage(y: number, m: number) {
    if (!active || !authenticated.get()) return
    const { from, to } = syncWindow(y, m)
    if (from < loadedFrom || to > loadedTo) sync({ y, m })
}

// stale-while-revalidate on popover open; age-gated so fidgety toggling
// doesn't burn quota
export function refresh() {
    if (!active || !authenticated.get()) return
    if (Date.now() - lastSyncAttempt < 60_000) return
    sync()
}

// --------------------------------------------------------------- cache

function writeCache(list: CalEvent[]) {
    try {
        GLib.file_set_contents(
            cachePath,
            JSON.stringify({ from: loadedFrom, to: loadedTo, events: list }),
        )
    } catch (e) {
        console.warn("GCal: failed writing cache:", e)
    }
}

function loadCache() {
    if (!isFile(cachePath)) return
    try {
        const contents = GLib.file_get_contents(cachePath)[1]
        const data = JSON.parse(new TextDecoder().decode(contents))
        if (Array.isArray(data?.events)) {
            loadedFrom = Number(data.from) || 0
            loadedTo = Number(data.to) || 0
            setEvents(data.events)
        }
    } catch (e) {
        console.warn("GCal: failed reading cache:", e)
    }
}

// -------------------------------------------------------------- timers

let pollTimer = 0

export function dispose() {
    if (pollTimer) {
        sourceRemove(pollTimer)
        pollTimer = 0
    }
    if (authTimeout) {
        sourceRemove(authTimeout)
        authTimeout = 0
    }
    if (authListener) {
        authListener.close()
        authListener = null
    }
    authInProgress = false
}

// -------------------------------------------------------------- startup

// explicit entry point (called from app.tsx): keeps network I/O out of
// module import and makes startup ordering visible
export function init() {
    if (!active) return
    loadTokens()
    loadCache() // instant marks from the last run; sync refreshes below
    if (tokens) {
        setAuthenticated(true)
        sync()
    }
    // armed even when signed out: the poll is inert until authenticate()
    // lands, then keeps the session fresh without a restart
    pollTimer = timeoutAddSeconds(
        "gcal:poll",
        GLib.PRIORITY_DEFAULT,
        Config.calendar.pollMinutes * 60,
        () => {
            sync()
            return GLib.SOURCE_CONTINUE
        },
    )
}
