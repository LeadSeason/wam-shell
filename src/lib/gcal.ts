import GLib from "gi://GLib?version=2.0"
import { createComputed, createState } from "gnim"
import Config from "../config"
import { isFile } from "./utils"
import { timeoutAddSeconds, sourceRemove } from "./metrics"
import { GoogleAccount, createGoogleAuth, googleRequest } from "./googleAuth"

// Google Calendar for the clock popover (Calendar API v3, read-only).
// Multiple calendars of the account are merged into one event list; the
// UI marks days on the Gtk.Calendar and lists the selected day. Auth is
// the shared Google OAuth stack (lib/googleAuth.ts): the user signs in
// once per account in the browser, the refresh token lives in
// gcal-tokens.json. Sync is a full refetch of a ~5-month window around
// the viewed month — small, quota-cheap, and stateless (no syncToken
// machinery). All date math is local; Google answers with UTC instants
// or exclusive all-day end dates, both normalized here.

const API = "https://www.googleapis.com/calendar/v3"
const configHome = `${GLib.getenv("XDG_CONFIG_HOME") || `${GLib.getenv("HOME")}/.config`}/wam-shell`
const cachePath = `${Config.instanceCacheDir}/gcal-events.json`

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

// ----------------------------------------------------------- auth

// the shared Google stack: embedded client + per-account tokens; the
// identity comes from the primary calendar's id (no extra scope needed)
const auth = createGoogleAuth({
    scope: "https://www.googleapis.com/auth/calendar.readonly",
    tokensPath: `${configHome}/gcal-tokens.json`,
    logTag: "GCal",
    enabled: Config.calendar.enabled,
    identify: (accessToken, cb) => {
        googleRequest(
            "GET",
            `${API}/users/me/calendarList?fields=items(id,primary)`,
            { bearer: accessToken },
            r => {
                if (!r.ok || !Array.isArray(r.json?.items)) return cb(null)
                cb(r.json.items.find((c: any) => c.primary)?.id ?? null)
            },
        )
    },
})

// widgets gate on this: enabled + credentials present
export const active = auth.active
// signed-in account emails — drives the popover's sign-in/add button
// and the event list's visibility
export const accountEmails = auth.accounts
export const authBusy = auth.authBusy
export const authenticate = auth.authenticate

// a revoked/expired refresh token drops just that account (googleAuth
// handles the tokens); its events and calendars leave the UI
// immediately rather than at the next sync
auth.onAccountRemoved(email => {
    setEvents(events.get().filter(e => e.account !== email))
    setCalendars(calendars.get().filter(c => c.account !== email))
})

// thin wrapper adding failure logging to the shared HTTP helper (the
// helper itself stays silent — headers/bodies carry secrets)
interface Reply {
    ok: boolean
    status: number
    json: any
}

function request(method: string, url: string, opts: { bearer?: string }, cb: (r: Reply) => void) {
    googleRequest(method, url, opts, r => {
        if (!r.ok)
            console.warn(`GCal: ${method} ${url.split("?")[0]} -> ${r.status || "network error"}`)
        cb(r)
    })
}

// ---------------------------------------------------------------- state

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
const [visibilityOverrides, setVisibilityOverrides] = createState<Record<string, boolean>>({})
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
    const start = new Date(startMs)
    const stop = localMidnight(last.getFullYear(), last.getMonth(), last.getDate())
    // step by local calendar day, not absolute 24h: across the
    // fall-back transition (a 25-hour day) midnight+86400s is still the
    // same local day, which duplicated the key and dropped the last one
    for (
        let d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
        d.getTime() <= stop && days.length < 62;
        d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
    ) {
        days.push(dayKey(d.getTime()))
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

// ---------------------------------------------------------------- sync

// GET a Calendar API path with the account's bearer, one refresh+retry
// on 401
function apiGet(account: GoogleAccount, path: string, cb: (r: Reply) => void, retried = false) {
    auth.ensureAccessToken(account, token => {
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
    account: GoogleAccount,
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
    account: GoogleAccount,
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
    if (!active || auth.getAccounts().length === 0 || syncInFlight) return
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
    const signedIn = auth.getAccounts()
    let pending = signedIn.length
    for (const account of signedIn) {
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
    if (!active || auth.getAccounts().length === 0) return
    const { from, to } = syncWindow(y, m)
    if (from < loadedFrom || to > loadedTo) sync({ y, m })
}

// stale-while-revalidate on popover open; age-gated so fidgety toggling
// doesn't burn quota
export function refresh() {
    if (!active || auth.getAccounts().length === 0) return
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
    auth.dispose()
}

// -------------------------------------------------------------- startup

// explicit entry point (called from app.tsx): keeps network I/O out of
// module import and makes startup ordering visible
export function init() {
    if (!active) return
    loadCache() // instant marks from the last run; sync refreshes below
    if (auth.getAccounts().length > 0) sync()
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
