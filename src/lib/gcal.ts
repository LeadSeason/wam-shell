import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import Soup from "gi://Soup?version=3.0"
import { createComputed, createState } from "gnim"
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
    id: string // accountEmail/calendarId:googleEventId (unique across accounts)
    account: string // the Google account (email) the event belongs to
    calendarId: string // Google's id of the owning calendar
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

// ---------------------------------------------------------- credentials
interface Credentials {
    clientId: string
    clientSecret: string
}

// project-owned OAuth desktop client: the zero-setup default. Google
// treats installed-app client secrets as non-confidential (their own
// docs say so), so embedding is expected practice — a personal
// google.env or the env vars still override it
const DEFAULT_CLIENT_ID = "596900825927-n0jv9hjsjcfb3nk8isvc74f13ji709v2.apps.googleusercontent.com"
const DEFAULT_CLIENT_SECRET = "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"

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

// precedence: env vars > google.env > the embedded project client
function loadCredentials(): Credentials | null {
    const envId = GLib.getenv("GOOGLE_CLIENT_ID")
    const envSecret = GLib.getenv("GOOGLE_CLIENT_SECRET")
    if (envId && envSecret) return { clientId: envId, clientSecret: envSecret }

    if (isFile(envPath)) {
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
        }
        if (clientId && clientSecret) return { clientId, clientSecret }
    }

    if (DEFAULT_CLIENT_ID && DEFAULT_CLIENT_SECRET) {
        return { clientId: DEFAULT_CLIENT_ID, clientSecret: DEFAULT_CLIENT_SECRET }
    }
    return null
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

// one OAuth client, any number of Google accounts behind it. Each
// account gets its own refresh token from its own sign-in flow; the
// email is discovered via the primary calendar's id (no extra scope
// needed) and is the account's stable key
interface Account {
    email: string // primary calendar id; "" until discovered
    refresh_token: string
    access_token: string
    expires_at: number // ms epoch
}

let accounts: Account[] = []

function loadTokens() {
    if (!isFile(tokensPath)) return
    warnPerms(tokensPath)
    try {
        const contents = GLib.file_get_contents(tokensPath)[1]
        const t = JSON.parse(new TextDecoder().decode(contents))
        if (Array.isArray(t?.accounts)) {
            accounts = t.accounts.filter(
                (a: any) => a?.refresh_token && typeof a?.access_token === "string",
            )
        }
    } catch (e) {
        console.warn("GCal: failed reading tokens:", e)
    }
}

// never log the contents: the tokens are secrets
function storeTokens() {
    try {
        GLib.file_set_contents(tokensPath, JSON.stringify({ accounts }))
    } catch (e) {
        console.warn("GCal: failed writing tokens:", e)
    }
}

// a revoked/expired refresh token drops just that account; others sync
// on unaffected. Its events leave the list immediately rather than at
// the next sync
function removeAccount(email: string) {
    accounts = accounts.filter(a => a.email !== email)
    storeTokens()
    setAccountEmails(accounts.map(a => a.email))
    setEvents(events.get().filter(e => e.account !== email))
    console.warn(
        `GCal: account ${email} signed out (refresh token rejected); sign in again from the clock popover`,
    )
}

// ---------------------------------------------------------------- state

// signed-in account emails — drives the popover's sign-in/add button
// and the event list's visibility
const [accountEmails, setAccountEmails] = createState<string[]>([])
export { accountEmails }
// merged events of all visible calendars of all accounts, sorted by
// startMs
const [events, setEvents] = createState<CalEvent[]>([])
export { events }

export interface CalInfo {
    id: string
    summary: string
    color: string
    account: string
}

// every calendar of every account (last sync), for the popover's
// picker pane
const [calendars, setCalendars] = createState<CalInfo[]>([])
export { calendars }

// session visibility overrides (calendar id -> visible); defaults come
// from config's hidden_calendars. Toggles live here so month dots and
// the agenda follow the same source
const [visibilityOverrides, setVisibilityOverrides] = createState<Record<string, boolean>>(
    {},
)
export { visibilityOverrides }

export function toggleCalendar(id: string) {
    const cal = calendars.get().find(c => c.id === id)
    if (!cal) return
    setVisibilityOverrides({
        ...visibilityOverrides.get(),
        [id]: !calendarVisible(cal, visibilityOverrides.get()),
    })
}

// pure: config hidden names + session overrides -> visible?
export function isVisible(
    cal: CalInfo,
    overrides: Record<string, boolean>,
    hiddenNames: string[],
): boolean {
    const o = overrides[cal.id]
    if (o !== undefined) return o
    return (
        !hiddenNames.includes(cal.summary) && !hiddenNames.includes(`${cal.account}:${cal.summary}`)
    )
}

export function calendarVisible(cal: CalInfo, overrides: Record<string, boolean>): boolean {
    return isVisible(cal, overrides, Config.calendar.hiddenCalendars)
}

// the events of currently-visible calendars: the popover's dots, day
// list and agenda all read this
export const visibleEvents = createComputed(
    [events, calendars, visibilityOverrides],
    (evts, cals, ovs) => {
        const byId = new Map(cals.map(c => [c.id, c]))
        return evts.filter(e => {
            const cal = byId.get(e.calendarId)
            return cal ? calendarVisible(cal, ovs) : true
        })
    },
)

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
    account: string,
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
        id: `${account}/${calendarId}:${raw.id ?? ""}`,
        account,
        calendarId,
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

export interface AgendaGroup {
    day: string // "YYYY-MM-DD"
    label: string // "Today", "Tomorrow", or "Tue, 05.08.2026"
    events: CalEvent[]
}

export interface GridDay {
    key: string // "YYYY-MM-DD"
    num: number // day-of-month number shown in the cell
    inMonth: boolean // false for the leading/trailing days of adjacent months
}

// 6x7 Monday-first grid for a displayed month (year + 0-based month):
// fixed row count so the grid never jumps height between months
export function monthGrid(year: number, month0: number): GridDay[][] {
    // getDay(): 0=Sunday..6=Saturday -> offset back to Monday
    const firstWeekday = (new Date(year, month0, 1).getDay() + 6) % 7
    const start = new Date(year, month0, 1 - firstWeekday)
    const weeks: GridDay[][] = []
    for (let w = 0; w < 6; w++) {
        const row: GridDay[] = []
        for (let i = 0; i < 7; i++) {
            const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + i)
            row.push({
                key: dayKey(d.getTime()),
                num: d.getDate(),
                inMonth: d.getMonth() === month0,
            })
        }
        weeks.push(row)
    }
    return weeks
}

// "Today" / "Tomorrow" / "Tue, 05.08.2026" for a day key
export function dayLabel(day: string, today: string): string {
    if (day === today) return "Today"
    const [ty, tm, td] = today.split("-").map(Number)
    if (day === dayKey(new Date(ty, tm - 1, td + 1).getTime())) return "Tomorrow"
    const [y, m, dd] = day.split("-").map(Number)
    return GLib.DateTime.new_local(y, m, dd, 0, 0, 0).format("%a, %d.%m.%Y") ?? day
}

// the popover's schedule view: days with events from `fromDay` onward,
// ascending, empty days skipped (Google Calendar's own schedule layout).
// `today` is dayKey(now) — passed in so the helper stays pure/testable
export function agendaGroups(events: CalEvent[], fromDay: string, today: string): AgendaGroup[] {
    const byDay = new Map<string, CalEvent[]>()
    for (const e of events) {
        for (const d of e.days) {
            if (d < fromDay) continue
            const list = byDay.get(d)
            if (list) list.push(e)
            else byDay.set(d, [e])
        }
    }
    return [...byDay.keys()].sort().map(d => ({
        day: d,
        label: dayLabel(d, today),
        events: byDay.get(d)!,
    }))
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
        if (!reply.ok)
            console.warn(
                `GCal: ${method} ${url.split("?")[0]} -> ${reply.status || "network error"}`,
            )
        cb(reply)
    })
}

// ----------------------------------------------------------- OAuth flow

let authInProgress = false
let authListener: Gio.SocketListener | null = null
let authTimeout = 0
// drives the popover's button label so a waiting flow is visible
const [authBusy, setAuthBusy] = createState(false)
export { authBusy }

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

// swap the auth code for tokens; refresh_token only appears with
// access_type=offline + prompt=consent. The account's email comes from
// its primary calendar's id; signing in an already-known account again
// just replaces its tokens
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
            if (!r.ok || !r.json?.refresh_token) {
                console.warn(`GCal: code exchange failed (status ${r.status})`)
                return
            }
            const account: Account = {
                email: "",
                refresh_token: r.json.refresh_token,
                access_token: r.json.access_token ?? "",
                expires_at: Date.now() + (Number(r.json.expires_in) || 0) * 1000,
            }
            // one request with the fresh token to learn who signed in
            request(
                "GET",
                `${API}/users/me/calendarList?fields=items(id,primary)`,
                { bearer: account.access_token },
                lr => {
                    if (lr.ok && Array.isArray(lr.json?.items)) {
                        account.email = lr.json.items.find((c: any) => c.primary)?.id ?? ""
                    }
                    if (!account.email) {
                        console.warn(
                            "GCal: signed in but could not identify the account; not storing it — try again",
                        )
                        return
                    }
                    accounts = [...accounts.filter(a => a.email !== account.email), account]
                    storeTokens()
                    setAccountEmails(accounts.map(a => a.email))
                    console.log(`GCal: signed in as ${account.email}`)
                    sync()
                },
            )
        },
    )
}

let redirectUri: string | null = null
let authUrl = ""

function openConsentPage() {
    Gio.AppInfo.launch_default_for_uri_async(authUrl, null, null, (_s, res) => {
        try {
            Gio.AppInfo.launch_default_for_uri_finish(res)
        } catch (e) {
            console.warn("GCal: could not open the browser:", e)
            finishAuth(false)
        }
    })
}

// user-initiated from the popover's sign-in button: listen on a random
// loopback port, open the consent page in the browser, wait for the
// redirect carrying the code. Always available — each completed flow
// adds (or re-authorizes) one Google account. While a flow waits, the
// button just RE-OPENS the same consent page: starting a competing
// flow per click sprinkles the browser with tabs whose redirects point
// at already-closed listeners (every flow gets a new random port)
export function authenticate() {
    if (!active) return
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
        console.warn("GCal: could not start the loopback listener:", e)
        return
    }
    authInProgress = true
    setAuthBusy(true)
    redirectUri = `http://127.0.0.1:${port}`

    // this flow's own listener, captured: on a restart the module-level
    // authListener already points at the NEW flow, and finishing the
    // old accept against it is invalid (and would tear down the wrong
    // listener). A torn-down listener's pending accept resolves
    // cancelled — silently ignore it
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
            // a newer flow replaced this one before its redirect landed
            try {
                conn.close(null)
            } catch {}
            return
        }
        conn.get_input_stream().read_bytes_async(8192, GLib.PRIORITY_DEFAULT, null, (s, res2) => {
            // a restart can land mid-read: the stale flow must not
            // finishAuth (it would tear down the new listener and
            // exchange the code against the wrong redirect_uri)
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
    authUrl = `${AUTH_URL}?${params}`
    console.log(`GCal: waiting for the sign-in redirect on ${redirectUri} (120s)`)
    openConsentPage()

    // don't wait (and listen) forever
    authTimeout = timeoutAddSeconds("gcal:authTimeout", GLib.PRIORITY_DEFAULT, 120, () => {
        authTimeout = 0
        console.warn("GCal: sign-in timed out")
        finishAuth(false)
        return GLib.SOURCE_REMOVE
    })
}

// access token for one account, refreshing when stale; cb(null) =
// unavailable (its sync skips, the next poll retries). Concurrent
// callers of the same account share one refresh
const refreshInFlight = new Map<string, ((t: string | null) => void)[]>()

function ensureAccessToken(account: Account, cb: (token: string | null) => void) {
    if (Date.now() < account.expires_at - 60_000) return cb(account.access_token)
    const waiters = refreshInFlight.get(account.email)
    if (waiters) {
        waiters.push(cb)
        return
    }
    refreshInFlight.set(account.email, [cb])
    request(
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
                // revoked/expired refresh token: only this account goes
                removeAccount(account.email)
            }
            const done = refreshInFlight.get(account.email) ?? []
            refreshInFlight.delete(account.email)
            for (const w of done) w(token)
        },
    )
}

// ---------------------------------------------------------------- sync

// GET a Calendar API path with the account's bearer, one refresh+retry
// on 401
function apiGet(account: Account, path: string, cb: (r: Reply) => void, retried = false) {
    ensureAccessToken(account, token => {
        if (!token) return cb({ ok: false, status: 401, json: null })
        request("GET", `${API}${path}`, { bearer: token }, r => {
            if (r.status === 401 && !retried) {
                // force a refresh by aging the cached token, then retry once
                account.expires_at = 0
                apiGet(account, path, cb, true)
                return
            }
            cb(r)
        })
    })
}

// bounded pagination: nextPageToken until exhausted (hard cap 10 pages)
function fetchPaged(
    account: Account,
    path: string,
    key: string,
    acc: any[],
    cb: (items: any[] | null) => void,
    page = 0,
) {
    if (page >= 10) return cb(acc)
    apiGet(account, path, r => {
        if (!r.ok || !r.json) return cb(r.ok ? acc : null)
        const items = acc.concat(r.json[key] ?? [])
        const next: string | null = r.json.nextPageToken ?? null
        if (next)
            fetchPaged(
                account,
                `${path}&pageToken=${encodeURIComponent(next)}`,
                key,
                items,
                cb,
                page + 1,
            )
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

// one account's slice of the merge: ALL its calendars' events in the
// window (visibility filtering happens at render time so picker
// toggles apply instantly), tagged with the account email. cb(null) =
// fetch failed (the merge degrades to the other accounts)
function syncAccount(
    account: Account,
    range: string,
    cb: (list: CalEvent[] | null, cals: CalInfo[]) => void,
) {
    fetchPaged(
        account,
        `/users/me/calendarList?fields=items(id,summary,backgroundColor)`,
        "items",
        [],
        cals => {
            if (!cals) return cb(null, [])
            const all: CalInfo[] = cals
                .filter((c: any) => c.id && c.summary)
                .map((c: any) => ({
                    id: c.id,
                    summary: c.summary,
                    color: typeof c.backgroundColor === "string" ? c.backgroundColor : "#888888",
                    account: account.email,
                }))
            if (all.length === 0) return cb([], [])

            const fields = "nextPageToken,items(id,status,summary,start,end)"
            const out: CalEvent[] = []
            let pending = all.length
            for (const cal of all) {
                const path = `/calendars/${encodeURIComponent(cal.id)}/events?${range}&singleEvents=true&maxResults=2500&fields=${encodeURIComponent(fields)}`
                fetchPaged(account, path, "items", [], items => {
                    // a failed calendar degrades to no events for it
                    // rather than poisoning the account's slice
                    for (const raw of items ?? []) {
                        const e = mapGoogleEvent(account.email, cal.id, cal.summary, cal.color, raw)
                        if (e) out.push(e)
                    }
                    if (--pending === 0) cb(out, all)
                })
            }
        },
    )
}

export function sync(focus?: { y: number; m: number }) {
    if (!active || accounts.length === 0 || syncInFlight) return
    syncInFlight = true
    lastSyncAttempt = Date.now()
    const now = new Date()
    const y = focus?.y ?? now.getFullYear()
    const m = focus?.m ?? now.getMonth()
    const { from, to } = syncWindow(y, m)
    const rfc3339 = (ms: number) => new Date(ms).toISOString()
    const range = `timeMin=${encodeURIComponent(rfc3339(from))}&timeMax=${encodeURIComponent(rfc3339(to))}`

    const merged: CalEvent[] = []
    const allCals: CalInfo[] = []
    let pending = accounts.length
    for (const account of [...accounts]) {
        syncAccount(account, range, (list, cals) => {
            if (list) merged.push(...list)
            allCals.push(...cals)
            if (--pending > 0) return
            merged.sort((a, b) => a.startMs - b.startMs)
            loadedFrom = from
            loadedTo = to
            setEvents(merged)
            setCalendars(allCals)
            writeCache(merged)
            syncInFlight = false
        })
    }
}

// the popover navigated to a month outside the loaded window
export function ensureCoverage(y: number, m: number) {
    if (!active || accounts.length === 0) return
    const { from, to } = syncWindow(y, m)
    if (from < loadedFrom || to > loadedTo) sync({ y, m })
}

// stale-while-revalidate on popover open; age-gated so fidgety toggling
// doesn't burn quota
export function refresh() {
    if (!active || accounts.length === 0) return
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
    setAccountEmails(accounts.map(a => a.email))
    if (accounts.length > 0) sync()
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
