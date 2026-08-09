import GLib from "gi://GLib?version=2.0"
import { createComputed, createState } from "gnim"
import Config from "../config"
import { isFile } from "./utils"
import { configHome } from "./paths"
import { writeFileAtomic } from "./atomicWrite"
import { timeoutAddSeconds, sourceRemove } from "./metrics"
import { GoogleAccount, createGoogleAuth, googleRequest } from "./googleAuth"
import { createRefreshGate, formatWait, isBackoffStatus, retryAfterSeconds } from "./providerCore"
import { WEEKDAYS } from "./relTime"
import { registerDispose } from "./lifecycle"

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
        // rate limited or overloaded: hold off the next sync rather than
        // arriving again on the fixed poll interval as if nothing was
        // said. Recorded from any request in the fan-out — one calendar
        // being limited means the account is
        if (isBackoffStatus(r.status)) {
            backoffs++
            const wait = retryAfterSeconds("", backoffs)
            backoffUntil = Math.max(backoffUntil, Date.now() + wait * 1000)
            console.warn(`GCal: ${r.status}; holding off syncs for ${formatWait(wait)}`)
        } else if (r.ok) {
            backoffs = 0
            backoffUntil = 0
        }
        cb(r)
    })
}

// consecutive 429/503s, and the instant the next sync may run.
//
// gcal keeps a plain fixed-interval timer rather than the providers'
// refresh gate -- it is the clock popover's data, not a notification
// provider -- so the hold-off lives here instead of in providerCore's
// gate. Same rule, one less mechanism to introduce.
let backoffs = 0
let backoffUntil = 0

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

// session visibility overrides (visKey -> visible); defaults come
// from config's hidden_calendars. Toggles live here so month dots and
// the agenda follow the same source
const [visibilityOverrides, setVisibilityOverrides] = createState<Record<string, boolean>>({})
export { visibilityOverrides }

// two accounts can subscribe to the SAME Google calendar id (holiday
// calendars, shared calendars added twice) — visibility is tracked per
// account, not per bare id, or the later account's entry wins for both
export const visKey = (cal: CalInfo) => `${cal.account}:${cal.id}`

export function toggleCalendar(cal: CalInfo) {
    setVisibilityOverrides({
        ...visibilityOverrides.get(),
        [visKey(cal)]: !calendarVisible(cal, visibilityOverrides.get()),
    })
}

// pure: config hidden names + session overrides -> visible?
export function isVisible(
    cal: CalInfo,
    overrides: Record<string, boolean>,
    hiddenNames: string[],
): boolean {
    const o = overrides[visKey(cal)]
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
        const byKey = new Map(cals.map(c => [`${c.account}:${c.id}`, c]))
        return evts.filter(e => {
            const cal = byKey.get(`${e.account}:${e.calendarId}`)
            return cal ? calendarVisible(cal, ovs) : true
        })
    },
)

// the loaded window: navigation outside it triggers a re-sync
let loadedFrom = 0 // ms epoch, first covered day
let loadedTo = 0 // ms epoch, exclusive

// ------------------------------------------------------- pure helpers

// local "YYYY-MM-DD" for a ms epoch — the key marks and lists filter on
export function dayKey(ms: number): string {
    const d = new Date(ms)
    const mo = String(d.getMonth() + 1).padStart(2, "0")
    const dy = String(d.getDate()).padStart(2, "0")
    return `${d.getFullYear()}-${mo}-${dy}`
}

// NB: on a spring-forward date in a zone that transitions AT midnight,
// this instant does not exist and JS resolves it to 01:00 — so an
// all-day event starting on such a date gets a startMs an hour late.
// Harmless as things stand, because dayKey() re-derives the calendar day
// from the timestamp and lands on the right one either way, and nothing
// renders an all-day event's clock time. Called out because the DST
// handling in eventDays() right below is careful and commented, and a
// reader will otherwise assume this line got the same treatment.
function localMidnight(y: number, m: number, d: number): number {
    return new Date(y, m, d).getTime()
}

// every local day an event touches. allDay ends are EXCLUSIVE per
// Google convention (a one-day event ends the next midnight); timed
// events ending exactly at midnight don't spill into that day. A
// zero-length event covers its start day only. Capped defensively: a
// broken feed must not produce 10k keys
//
// `_allDay` is deliberately unused: the two cases converged once the
// rule was stated as "the last covered instant is end-1ms", which is
// true of both. It stays in the signature because callers still have to
// know which kind they hold to normalize the end in the first place
// (mapGoogleEvent does), and the tests pass both to pin that they agree
export function eventDays(startMs: number, endMs: number, _allDay: boolean): string[] {
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

// ISO-8601 week number of a local date: week 1 contains the year's
// first Thursday (both the grid rows and this count are Monday-first)
export function isoWeekNumber(d: Date): number {
    const date = new Date(d.getFullYear(), d.getMonth(), d.getDate())
    const day = (date.getDay() + 6) % 7 // Mon=0..Sun=6
    date.setDate(date.getDate() - day + 3) // Thursday of this week
    const firstThursday = new Date(date.getFullYear(), 0, 4)
    const firstDay = (firstThursday.getDay() + 6) % 7
    firstThursday.setDate(firstThursday.getDate() - firstDay + 3)
    return 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000))
}

// "Today" / "Tomorrow" / "Tue, 05.08.2026" for a day key.
//
// The weekday comes from relTime's list rather than from %a, which
// follows the LOCALE — and "Today" and "Tomorrow" above never can, so
// this agenda read "Today / Tomorrow / tis, 05.08.2026", switching
// language two rows in. Same reasoning, and now the same list, as the
// notification center's day dividers
export function dayLabel(day: string, today: string): string {
    if (day === today) return "Today"
    const [ty, tm, td] = today.split("-").map(Number)
    if (day === dayKey(new Date(ty, tm - 1, td + 1).getTime())) return "Tomorrow"
    const [y, m, dd] = day.split("-").map(Number)
    const date = new Date(y, m - 1, dd)
    if (Number.isNaN(date.getTime())) return day
    // getDay() is 0=Sunday; WEEKDAYS is Monday-first
    const weekday = WEEKDAYS[(date.getDay() + 6) % 7].slice(0, 3)
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${weekday}, ${pad(dd)}.${pad(m)}.${y}`
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
// fetch failed (the merge keeps the account's previous events)
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

// the last focus requested while a sync was in flight: covered as
// soon as the in-flight sync completes instead of waiting for the
// next poll
let pendingFocus: { y: number; m: number } | null = null

export function sync(focus?: { y: number; m: number }) {
    // a 429/503 asked us to stop for a while; the fixed poll timer must
    // respect that too, not just walk past it on the next tick
    if (Date.now() < backoffUntil) return
    if (!active || auth.getAccounts().length === 0) return
    if (syncInFlight) {
        pendingFocus = focus ?? pendingFocus
        return
    }
    syncInFlight = true
    gate.touch()
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
    let failedAccounts = 0
    for (const account of signedIn) {
        syncAccount(account, range, (list, cals) => {
            if (list) {
                merged.push(...list)
                allCals.push(...cals)
            } else {
                failedAccounts++
                // transient failure: keep the account's previous events
                // (clamped to the window) and calendars instead of
                // blanking it until the next successful sync — same
                // keep-stale policy as the github/todoist providers
                merged.push(
                    ...events
                        .get()
                        .filter(
                            e => e.account === account.email && e.endMs >= from && e.startMs <= to,
                        ),
                )
                allCals.push(...calendars.get().filter(c => c.account === account.email))
            }
            if (--pending > 0) return
            merged.sort((a, b) => a.startMs - b.startMs)
            // a window is only "loaded" when at least one account
            // actually synced: advancing past a total failure would
            // stop ensureCoverage from retrying the new month until the
            // next poll (default 15 min). The cache gets the same guard:
            // clamped stale events under old bounds would read as
            // loaded-but-empty months after a restart
            if (failedAccounts < signedIn.length) {
                loadedFrom = from
                loadedTo = to
                writeCache(merged)
            }
            setEvents(merged)
            setCalendars(allCals)
            syncInFlight = false
            // cover whatever the user navigated to while we were syncing
            if (pendingFocus) {
                const f = pendingFocus
                pendingFocus = null
                ensureCoverage(f.y, f.m)
            }
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
// doesn't burn quota. The signed-out check comes first: opening the
// popover before a sign-in must not consume the gate's window, or the
// first sync after signing in would be a minute late
const gate = createRefreshGate(60_000, () => sync())
export function refresh() {
    if (!active || auth.getAccounts().length === 0) return
    gate.refresh()
}

// --------------------------------------------------------------- cache

// the serialized window is multi-hundred-KB and syncs run every poll:
// skip the write entirely when the payload didn't change
let lastCacheJson = ""

function writeCache(list: CalEvent[]) {
    const json = JSON.stringify({ from: loadedFrom, to: loadedTo, events: list })
    if (json === lastCacheJson) return
    lastCacheJson = json
    writeFileAtomic(cachePath, json).catch(e => console.warn("GCal: failed writing cache:", e))
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
    // no poll timer while signed out (the perf gate counts it): the
    // first sign-in arms it via onAccountAdded
    const arm = () => {
        if (pollTimer) return
        sync()
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
    if (auth.getAccounts().length > 0) arm()
    else auth.onAccountAdded(arm)
}

// tear-down entry point, run from app.tsx on shutdown (lib/lifecycle)
registerDispose("gcal", dispose)
