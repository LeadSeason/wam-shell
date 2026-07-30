import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import Soup from "gi://Soup?version=3.0"
import AstalNetwork from "gi://AstalNetwork?version=0.1"
import { createState } from "gnim"
import { readFile } from "ags/file"
import Config from "../config"
import { isFile } from "./utils"

// Harvest time tracking (api v2). The widget mirrors timers that live on
// Harvest's servers: nothing here owns a timer, a shell restart simply
// re-syncs. Fast poll = the volatile stuff (running probe + today's
// entries), slow poll = near-static stuff (project assignments, wide
// recents window). All date math is local; the ±1d query widening makes
// the server-side spent_date filter timezone-insensitive.

const BASE = "https://api.harvestapp.com/v2"
// Harvest 400s requests without a User-Agent
const UA = "wam-shell (https://github.com/LeadSeason/wam-shell)"

// ---------------------------------------------------------------- types

export interface Entry {
    id: number
    spentDate: string // "YYYY-MM-DD"
    hours: number
    hoursWithoutTimer: number | null
    timerStartedAt: string | null // ISO 8601
    startedTime: string | null // "3:00pm" or "15:00"
    isRunning: boolean
    notes: string
    updatedAt: string
    projectId: number
    projectName: string
    taskId: number
    taskName: string
    clientName: string
}

export interface Project {
    projectId: number
    projectName: string
    clientName: string
    tasks: { taskId: number; taskName: string }[]
}

// ---------------------------------------------------------- credentials

interface Credentials {
    token: string
    accountId: string
}

function loadCredentials(): Credentials | null {
    const envToken = GLib.getenv("HARVEST_TOKEN")
    const envAccount = GLib.getenv("HARVEST_ACCOUNT_ID")
    if (envToken && envAccount) return { token: envToken, accountId: envAccount }

    const configHome = GLib.getenv("XDG_CONFIG_HOME") || `${GLib.getenv("HOME")}/.config`
    const path = `${configHome}/wam-shell/harvest.env`
    if (!isFile(path)) return null

    // documented chmod 600 is advice; warn when group/other can read it
    try {
        const info = Gio.File.new_for_path(path).query_info(
            "unix::mode",
            Gio.FileQueryInfoFlags.NONE,
            null,
        )
        const mode = info.get_attribute_uint32("unix::mode") & 0o777
        if (mode & 0o077) {
            console.warn(
                `Harvest: ${path} is readable by group/other (mode ${mode.toString(8)}); consider chmod 600`,
            )
        }
    } catch (e) {
        console.warn("Harvest: could not stat credentials file:", e)
    }

    let token = "",
        accountId = ""
    try {
        const contents = GLib.file_get_contents(path)[1]
        const text = new TextDecoder().decode(contents)
        for (const line of text.split("\n")) {
            const m = line.match(/^\s*(HARVEST_TOKEN|HARVEST_ACCOUNT_ID)\s*=\s*(.+?)\s*$/)
            if (!m) continue
            // tolerate inline comments and single/double quotes
            const value = m[2].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "")
            if (m[1] === "HARVEST_TOKEN") token = value
            else accountId = value
        }
    } catch (e) {
        console.warn("Harvest: failed reading credentials file:", e)
        return null
    }
    return token && accountId ? { token, accountId } : null
}

const creds = Config.harvest.enabled ? loadCredentials() : null
// widgets gate on this: enabled + credentials present
export const active = Config.harvest.enabled && creds !== null
if (Config.harvest.enabled && !creds) {
    console.log(
        "Harvest: enabled but no credentials (env HARVEST_TOKEN/HARVEST_ACCOUNT_ID or ~/.config/wam-shell/harvest.env); widget disabled",
    )
}

// ---------------------------------------------------------------- state

const [running, setRunning] = createState<Entry | null>(null)
export { running }
// live seconds of the running entry, ticked locally every second
const [elapsed, setElapsed] = createState(0)
export { elapsed }
// today's total in seconds (live running time included)
const [dayTotal, setDayTotal] = createState(0)
export { dayTotal }
const [projects, setProjects] = createState<Project[]>([])
export { projects }
// recent entries deduped by project/task, most recent first
const [recents, setRecents] = createState<Entry[]>([])
export { recents }
const [lastStopped, setLastStopped] = createState<Entry | null>(null)
export { lastStopped }
// today's stopped entries, most recently updated first (resume targets)
const [recentStopped, setRecentStopped] = createState<Entry[]>([])
export { recentStopped }
// an entry the user "paused": stopped with intent to resume. Purely a UI
// distinction — the API only knows start/stop, and restart keeps
// accumulating on the same row (verified against the live API). Cleared
// whenever any timer starts, here or elsewhere.
const [paused, setPaused] = createState<Entry | null>(null)
export { paused }
const [busy, setBusy] = createState(false)
export { busy }
const [authDisabled, setAuthDisabled] = createState(false)
export { authDisabled }

// account mode, fetched at startup (403 = not an admin -> defaults)
let wantsTimestampTimers = false
let accountClock: "12h" | "24h" = "12h"
let timeFormat: "decimal" | "hours_minutes" = "hours_minutes"

// ------------------------------------------------------------- helpers

function localDay(offsetDays = 0): string {
    const now = GLib.DateTime.new_now_local()
    const day = offsetDays ? now.add_days(offsetDays)! : now
    return day.format("%Y-%m-%d")!
}

// start of the running segment in ms, tolerating both account modes
function startMs(e: Entry): number | null {
    if (e.timerStartedAt) {
        const t = Date.parse(e.timerStartedAt)
        if (!Number.isNaN(t)) return t
    }
    if (e.startedTime) {
        // accepts the account's clock format and the other one too
        const m =
            e.startedTime.trim().match(/^(\d{1,2}):(\d{2})\s*([ap])\.?m\.?$/i) ??
            e.startedTime.trim().match(/^(\d{1,2}):(\d{2})$/)
        if (m) {
            let h = Number(m[1])
            const min = Number(m[2])
            const ap = m[3]?.toLowerCase()
            if (ap === "p" && h < 12) h += 12
            if (ap === "a" && h === 12) h = 0
            const [y, mo, d] = e.spentDate.split("-").map(Number)
            if (y && mo && d) return new Date(y, mo - 1, d, h, min).getTime()
        }
    }
    return null
}

function liveSeconds(e: Entry): number {
    // hours already includes the live segment for a running entry, so
    // without hours_without_timer the only safe base is 0
    const base = (e.hoursWithoutTimer ?? 0) * 3600
    const start = startMs(e)
    if (start === null) return base
    return base + Math.max(0, (Date.now() - start) / 1000)
}

export function formatElapsed(seconds: number): string {
    // honor the account's Time Format setting (company.time_format)
    if (timeFormat === "decimal") return (seconds / 3600).toFixed(2)
    const totalMin = Math.floor(seconds / 60)
    const h = Math.floor(totalMin / 60)
    const m = totalMin % 60
    return `${h}:${m.toString().padStart(2, "0")}`
}

function mapEntry(e: any): Entry {
    return {
        id: e.id ?? 0,
        spentDate: e.spent_date ?? "",
        hours: e.hours ?? 0,
        hoursWithoutTimer: e.hours_without_timer ?? null,
        timerStartedAt: e.timer_started_at ?? null,
        startedTime: e.started_time ?? null,
        isRunning: !!e.is_running,
        notes: e.notes ?? "",
        updatedAt: e.updated_at ?? "",
        projectId: e.project?.id ?? 0,
        projectName: e.project?.name ?? "",
        taskId: e.task?.id ?? 0,
        taskName: e.task?.name ?? "",
        clientName: e.client?.name ?? "",
    }
}

/** send a notification through the daemon (same pattern as bluetooth) */
function notify(summary: string, body: string) {
    Gio.DBus.session.call(
        "org.freedesktop.Notifications",
        "/org/freedesktop/Notifications",
        "org.freedesktop.Notifications",
        "Notify",
        new GLib.Variant("(susssasa{sv}i)", [
            "wam-shell",
            0,
            "dialog-warning-symbolic",
            summary,
            body,
            [],
            { urgency: new GLib.Variant("y", 2) },
            -1,
        ]),
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (_conn, res) => {
            try {
                Gio.DBus.session.call_finish(res)
            } catch (e) {
                console.warn("harvest notify failed:", e)
            }
        },
    )
}

// ---------------------------------------------------------------- http

const session = new Soup.Session({ timeout: 20 })

interface Reply {
    ok: boolean // 2xx with parseable body (or no body needed)
    authFailed: boolean // 401/403
    status: number
    json: any
    retryAfter: number // seconds, from 429 responses (0 = absent)
}

// never log anything beyond method + path + status: headers carry the token
function request(method: string, path: string, body: any, cb: (r: Reply) => void) {
    const msg = Soup.Message.new(method, `${BASE}${path}`)
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
    session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (_s, res) => {
        let reply: Reply
        try {
            const bytes = session.send_and_read_finish(res)
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

// follow links.next until exhausted (cursor- and page-based endpoints alike)
function fetchAll(
    path: string,
    key: string,
    acc: any[],
    cb: (items: any[] | null, r: Reply) => void,
    retried = false,
) {
    request("GET", path, null, r => {
        // one bounded retry on throttle: a 429 would otherwise silently
        // abandon the whole slow fetch
        if (r.status === 429 && !retried) {
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, Math.max(r.retryAfter, 1), () => {
                fetchAll(path, key, acc, cb, true)
                return GLib.SOURCE_REMOVE
            })
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

// ------------------------------------------------------- polling engine

let fastTimer = 0
let slowTimer = 0
let baselineTimer = 0
let tickerSource = 0
let authStrikes = 0
let backoffLevel = 0
let lastSlowFetch = 0

// delta sync state
let userId = 0
let highWater = 0 // ms epoch; from server updated_at values only
let seeded = false // the first baseline window has landed
const todayMap = new Map<number, Entry>()
// response ordering, per resource: a slower older poll must not
// overwrite a newer one *of the same query*. A single shared counter
// would let the window discard the running probe (and vice versa)
let requestSeq = 0
const lastApplied = { delta: 0, window: 0, running: 0 }
// lock gating + post-resume failure forgiveness
let locked = false
let forgiveFailuresUntil = 0

const BACKOFF_CAP = 600 // seconds

function effectiveInterval(): number {
    const base = (locked ? 60 : Config.harvest.pollInterval) * Math.pow(2, backoffLevel)
    return Math.min(base, BACKOFF_CAP)
}

function scheduleNext(retryAfter = 0) {
    if (authDisabled.get()) return
    if (fastTimer) GLib.source_remove(fastTimer)
    const delay = Math.max(retryAfter, effectiveInterval())
    fastTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
        fastTimer = 0
        deltaPoll()
        return GLib.SOURCE_REMOVE
    })
}

function settleCycle(authFailed: boolean, failed: boolean, retryAfter = 0) {
    if (authFailed) {
        // one strike per cycle, not per request: a bad token fails every
        // request in the batch from one cause
        authStrikes++
        if (authStrikes >= 2) {
            disableAuth()
            return
        }
    } else {
        authStrikes = 0
    }
    // failures right after a resume/reconnect are the NIC coming up, not
    // an outage — don't back off for them
    if (failed && Date.now() > forgiveFailuresUntil) backoffLevel = Math.min(backoffLevel + 1, 5)
    else if (!failed) backoffLevel = 0
    scheduleNext(retryAfter)
}

// identity churn rebuilds the popup header (and its notes field) under
// the user; skip adoption when nothing material changed
function sameEntry(a: Entry | null, b: Entry | null): boolean {
    if (a === b) return true
    if (!a || !b) return false
    return (
        a.id === b.id &&
        a.updatedAt === b.updatedAt &&
        a.isRunning === b.isRunning &&
        a.notes === b.notes
    )
}

function adoptRunning(entry: Entry | null) {
    const prev = running.get()
    if (sameEntry(prev, entry)) return
    setRunning(entry)
    if (entry) {
        // a timer running means nothing is paused anymore
        setPaused(null)
        // keep ticking from the server's numbers, not our stale ones
        setElapsed(liveSeconds(entry))
        armTicker()
    } else {
        setElapsed(0)
        disarmTicker()
    }
    if (prev?.id !== entry?.id) refreshDayTotal()
}

let stoppedTodaySec = 0

function refreshStoppedFromMap() {
    const stopped = [...todayMap.values()]
        .filter(e => !e.isRunning)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    stoppedTodaySec = stopped.reduce((sum, e) => sum + e.hours * 3600, 0)
    refreshDayTotal()
    setLastStopped(stopped[0] ?? null)
    setRecentStopped(stopped.slice(0, 3))
}

function refreshDayTotal() {
    const cur = running.get()
    setDayTotal(stoppedTodaySec + (cur ? todaySeconds(cur) : 0))
}

// today's portion of the running entry: hours accrued before midnight
// don't count toward today's total
function todaySeconds(e: Entry): number {
    const base =
        e.spentDate === localDay()
            ? // same live-segment double-count rule as liveSeconds
              (e.hoursWithoutTimer ?? 0) * 3600
            : 0
    const start = startMs(e)
    if (start === null) return base
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    return base + Math.max(0, (Date.now() - Math.max(start, midnight.getTime())) / 1000)
}

// apply a delta response: upsert today's entries, advance the high-water
// mark (forward only), adopt running transitions
function applyDelta(entries: Entry[]) {
    const cur = running.get()
    const runningEntry = entries.find(e => e.isRunning)
    const today = localDay() // hoisted: one DateTime per delta, not per entry
    let transition = false
    let maxUpdated = highWater
    for (const e of entries) {
        const t = Date.parse(e.updatedAt)
        if (!Number.isNaN(t)) maxUpdated = Math.max(maxUpdated, t)
        if (e.spentDate === today) todayMap.set(e.id, e)
        if (e.isRunning) {
            if (cur?.id !== e.id) transition = true
        } else if (cur && e.id === cur.id) {
            transition = true
        }
    }
    highWater = maxUpdated
    if (runningEntry) adoptRunning(runningEntry)
    else if (cur && entries.some(e => e.id === cur.id)) adoptRunning(null)
    if (transition) fetchWindow()
    refreshStoppedFromMap()
}

// one small delta request per fast tick; the highWater-2s overlap kills
// the same-second boundary class and upserts are idempotent
let deltaInFlight = false

export function deltaPoll() {
    if (!active || authDisabled.get()) return
    if (!seeded) {
        scheduleNext()
        return
    }
    // coalesce: the scheduled tick, mutations, unlock, connectivity and
    // the popup can all trigger at once; one in flight is enough
    if (deltaInFlight) return
    deltaInFlight = true
    const seq = ++requestSeq
    const since = new Date(Math.max(0, highWater - 2000)).toISOString()
    const uid = userId ? `&user_id=${userId}` : ""
    request("GET", `/time_entries?updated_since=${encodeURIComponent(since)}${uid}`, null, r => {
        deltaInFlight = false
        if (r.ok && r.json && seq > lastApplied.delta) {
            lastApplied.delta = seq
            applyDelta((r.json.time_entries ?? []).map(mapEntry))
        }
        settleCycle(r.authFailed, !r.ok, r.retryAfter)
    })
}

// the ±1d window: re-seeds the today map and resume targets. Fired on
// running transitions and as part of the baseline
function fetchWindow() {
    const seq = ++requestSeq
    request("GET", `/time_entries?from=${localDay(-1)}&to=${localDay(1)}`, null, r => {
        if (r.ok && r.json && seq > lastApplied.window) {
            lastApplied.window = seq
            todayMap.clear()
            let maxUpdated = 0
            for (const raw of r.json.time_entries ?? []) {
                const e = mapEntry(raw)
                if (e.spentDate === localDay()) todayMap.set(e.id, e)
                const t = Date.parse(e.updatedAt)
                if (!Number.isNaN(t)) maxUpdated = Math.max(maxUpdated, t)
            }
            // the high-water mark is seeded here once, then advanced by
            // deltas only (forward only, never from the baseline)
            if (!seeded) {
                highWater = maxUpdated || Date.now() - 5 * 60_000
                seeded = true
            }
            refreshStoppedFromMap()
        }
    })
}

// correctness floor: the unbounded running probe (weekend timer, missed
// stops) + the window (heals deletions and slipped deltas), every 5 min.
// the window goes first so the probe carries the newer sequence tag —
// otherwise a fast window response could discard the probe's adoption
function baseline() {
    if (!active || authDisabled.get()) return
    fetchWindow()
    const seq = ++requestSeq
    request("GET", "/time_entries?is_running=true", null, r => {
        if (r.ok && r.json && seq > lastApplied.running) {
            lastApplied.running = seq
            const raw = (r.json.time_entries ?? [])[0]
            adoptRunning(raw ? mapEntry(raw) : null)
        }
    })
}

function slowCycle() {
    if (!active || authDisabled.get()) return
    lastSlowFetch = Date.now()
    // near-static: projects + tasks for the picker (cursor-paginated)
    fetchAll("/users/me/project_assignments", "project_assignments", [], (items, _r) => {
        if (items) {
            setProjects(
                items.map((a: any): Project => ({
                    projectId: a.project?.id ?? 0,
                    projectName: a.project?.name ?? "",
                    clientName: a.client?.name ?? "",
                    tasks: (a.task_assignments ?? [])
                        .filter((t: any) => t.is_active !== false)
                        .map((t: any) => ({
                            taskId: t.task?.id ?? 0,
                            taskName: t.task?.name ?? "",
                        })),
                })),
            )
        }
    })
    // wide window for the dropdown's recent project/task pairs
    fetchAll(
        `/time_entries?from=${localDay(-30)}&to=${localDay(1)}`,
        "time_entries",
        [],
        (items, _r) => {
            if (items) {
                const entries: Entry[] = items.map(mapEntry)
                const seen = new Set<string>()
                const pairs: Entry[] = []
                // API returns ascending spent_date; walk newest first
                for (const e of [...entries].reverse()) {
                    const key = `${e.projectId}/${e.taskId}`
                    if (seen.has(key)) continue
                    seen.add(key)
                    pairs.push(e)
                    if (pairs.length >= Math.max(Config.harvest.recents, 5)) break
                }
                setRecents(pairs)
            }
        },
    )
}

// the displayed string changes at most once per 36s (decimal) or 60s
// (h:mm): schedule exactly those instants instead of a 1 Hz ticker
function msUntilNextChange(sec: number): number {
    const period = timeFormat === "decimal" ? 36_000 : 60_000
    return Math.max(250, period - ((sec * 1000) % period))
}

function armTicker() {
    if (tickerSource) return
    const fire = () => {
        tickerSource = 0
        const cur = running.get()
        if (!cur) return GLib.SOURCE_REMOVE
        const secs = liveSeconds(cur)
        setElapsed(secs)
        refreshDayTotal()
        tickerSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, msUntilNextChange(secs), fire)
        return GLib.SOURCE_REMOVE
    }
    const cur = running.get()
    if (cur) {
        tickerSource = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            msUntilNextChange(liveSeconds(cur)),
            fire,
        )
    }
}

function disarmTicker() {
    if (tickerSource) {
        GLib.source_remove(tickerSource)
        tickerSource = 0
    }
}

let rolloverTimer = 0

function msUntilMidnight(): number {
    const d = new Date()
    d.setHours(24, 0, 0, 0) // next local midnight
    return d.getTime() - Date.now() + 1000
}

// re-seed "today" at local midnight instead of waiting for the baseline
function armRollover() {
    if (rolloverTimer) GLib.source_remove(rolloverTimer)
    rolloverTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, msUntilMidnight(), () => {
        rolloverTimer = 0
        fetchWindow()
        armRollover()
        return GLib.SOURCE_REMOVE
    })
}

function disableAuth() {
    if (authDisabled.get()) return
    setAuthDisabled(true)
    if (fastTimer) {
        GLib.source_remove(fastTimer)
        fastTimer = 0
    }
    if (slowTimer) {
        GLib.source_remove(slowTimer)
        slowTimer = 0
    }
    if (baselineTimer) {
        GLib.source_remove(baselineTimer)
        baselineTimer = 0
    }
    console.warn("Harvest: disabling after repeated authentication failures")
    notify(
        "Harvest authentication failed",
        "Check ~/.config/wam-shell/harvest.env — the widget is disabled until the shell restarts.",
    )
}

// ------------------------------------------------------------- actions
// serialized: one mutation in flight, further clicks ignored while busy;
// the poll backoff never applies here, clicks fire immediately

let mutInFlight = false

function mutate(work: (done: (resync?: boolean) => void) => void) {
    if (mutInFlight || authDisabled.get()) return
    mutInFlight = true
    setBusy(true)
    // older poll responses (any resource) must not resurrect
    // pre-mutation state
    requestSeq++
    lastApplied.delta = requestSeq
    lastApplied.window = requestSeq
    lastApplied.running = requestSeq
    work((resync = false) => {
        mutInFlight = false
        setBusy(false)
        // most mutation responses are authoritative; only startTimer
        // needs a follow-up (to catch the auto-stopped predecessor)
        if (resync) deltaPoll()
        else scheduleNext()
    })
}

export function stopRunning() {
    const cur = running.get()
    if (!cur) return
    mutate(done => {
        request("PATCH", `/time_entries/${cur.id}/stop`, null, r => {
            if (r.ok) adoptRunning(null)
            else console.warn(`Harvest: stop failed (status ${r.status})`)
            done()
        })
    })
}

// stop with intent to resume: same API call, but the entry is kept as the
// prominent resume target
export function pauseTimer() {
    const cur = running.get()
    if (!cur) return
    mutate(done => {
        request("PATCH", `/time_entries/${cur.id}/stop`, null, r => {
            if (r.ok && r.json) {
                setPaused(mapEntry(r.json))
                adoptRunning(null)
            } else console.warn(`Harvest: pause failed (status ${r.status})`)
            done()
        })
    })
}

const clockFmt = () => (accountClock === "24h" ? "%H:%M" : "%-I:%M%p")

function createEntry(
    projectId: number,
    taskId: number,
    done: (ok: boolean) => void,
    notes?: string,
) {
    const body: Record<string, any> = {
        project_id: projectId,
        task_id: taskId,
        spent_date: localDay(),
    }
    if (notes) body.notes = notes
    // timestamp accounts: started_time defaults to now, ended_time omitted
    // leaves it running; duration accounts: no hours = running
    if (wantsTimestampTimers) {
        body.started_time = GLib.DateTime.new_now_local().format(clockFmt())!.toLowerCase()
    }
    request("POST", "/time_entries", body, r => {
        if (r.ok && r.json) adoptRunning(mapEntry(r.json))
        done(r.ok)
    })
}

// a completed entry with explicit hours; does not disturb the running timer
export function addEntry(projectId: number, taskId: number, hours: number, notes?: string) {
    if (hours <= 0) return
    mutate(done => {
        const body: Record<string, any> = {
            project_id: projectId,
            task_id: taskId,
            spent_date: localDay(),
        }
        if (notes) body.notes = notes
        if (wantsTimestampTimers) {
            // start/end form: derive the window from the duration
            const end = GLib.DateTime.new_now_local()
            const start = end.add_seconds(-Math.round(hours * 3600))!
            body.started_time = start.format(clockFmt())!.toLowerCase()
            body.ended_time = end.format(clockFmt())!.toLowerCase()
        } else {
            body.hours = hours
        }
        request("POST", "/time_entries", body, r => {
            if (!r.ok) console.warn(`Harvest: add entry failed (status ${r.status})`)
            done()
        })
    })
}

export function startTimer(projectId: number, taskId: number, notes?: string) {
    // single call: verified against the live API that POST auto-stops the
    // currently running entry, so no stop-first / rollback dance is needed
    mutate(done => {
        createEntry(projectId, taskId, () => done(true), notes)
    })
}

// Harvest's native resume. Verified against the live API: restart keeps
// the same entry id (hours accumulate on the same row); the response body
// is adopted as-is either way
export function resumeEntry(entry: Entry) {
    if (entry.isRunning) return
    mutate(done => {
        request("PATCH", `/time_entries/${entry.id}/restart`, null, r => {
            if (r.ok && r.json) adoptRunning(mapEntry(r.json))
            else console.warn(`Harvest: restart failed (status ${r.status})`)
            done()
        })
    })
}

export function resumeLast() {
    const target = paused.get() ?? recentStopped.get()[0] ?? recents.get()[0] ?? null
    if (target) resumeEntry(target)
}

// false when the update could not even be attempted (busy/disabled), so
// the notes field keeps its dirty state instead of silently dropping text
export function setNotes(text: string): boolean {
    const cur = running.get()
    if (!cur || mutInFlight || authDisabled.get()) return false
    mutate(done => {
        request("PATCH", `/time_entries/${cur.id}`, { notes: text }, r => {
            if (r.ok && r.json) adoptRunning(mapEntry(r.json))
            else console.warn(`Harvest: notes update failed (status ${r.status})`)
            done()
        })
    })
    return true
}

// stale-while-revalidate when the picker popup opens; age-gated so
// fidgety toggling doesn't burn request quota
export function refreshSlow() {
    if (Date.now() - lastSlowFetch < 300_000) return
    slowCycle()
}

// -------------------------------------------------- lock + connectivity

// locked/suspended are the only states where nobody reads the panel:
// locked -> 60s ticks, unlock -> immediate poll. Watched via logind's
// LockedHint on our session; skipped when the process has no session.
function watchLock() {
    let pid = 0
    try {
        pid = Number(readFile("/proc/self/stat").split(" ")[0])
    } catch {
        return
    }
    // async from the start: no sync D-Bus round trips on the startup path
    Gio.DBus.system.call(
        "org.freedesktop.login1",
        "/org/freedesktop/login1",
        "org.freedesktop.login1.Manager",
        "GetSessionByPID",
        new GLib.Variant("(u)", [pid]),
        new GLib.VariantType("(o)"),
        Gio.DBusCallFlags.NONE,
        1000,
        null,
        (_conn, res) => {
            let sessionPath: string
            try {
                sessionPath = Gio.DBus.system.call_finish(res).get_child_value(0).get_string()[0]
            } catch {
                return // not in a registered session: no lock gating
            }
            Gio.DBus.system.call(
                "org.freedesktop.login1",
                sessionPath,
                "org.freedesktop.DBus.Properties",
                "Get",
                new GLib.Variant("(ss)", ["org.freedesktop.login1.Session", "LockedHint"]),
                new GLib.VariantType("(v)"),
                Gio.DBusCallFlags.NONE,
                1000,
                null,
                (_c2, res2) => {
                    try {
                        locked = Gio.DBus.system
                            .call_finish(res2)
                            .get_child_value(0)
                            .get_variant()
                            .get_boolean()
                    } catch (e) {
                        console.warn("Harvest: LockedHint read failed:", e)
                    }
                },
            )
            Gio.DBus.system.signal_subscribe(
                "org.freedesktop.login1",
                "org.freedesktop.DBus.Properties",
                "PropertiesChanged",
                sessionPath,
                "org.freedesktop.login1.Session",
                Gio.DBusSignalFlags.NONE,
                (_c, _s, _p, _i, _sig, params) => {
                    const v = params.get_child_value(1).lookup_value("LockedHint", null)
                    if (!v) return
                    const nowLocked = v.get_boolean()
                    if (nowLocked === locked) return
                    locked = nowLocked
                    if (!locked) deltaPoll()
                },
            )
        },
    )
}

// resume from suspend: poll on the connectivity edge, not the sleep
// signal (the NIC is still coming up then). Failures for ~30s after a
// resume or reconnect are forgiven, not backed off.
function watchConnectivity() {
    Gio.DBus.system.signal_subscribe(
        "org.freedesktop.login1",
        "org.freedesktop.login1.Manager",
        "PrepareForSleep",
        null,
        null,
        Gio.DBusSignalFlags.NONE,
        (_c, _s, _p, _i, _sig, params) => {
            if (!params.get_child_value(0).get_boolean()) {
                forgiveFailuresUntil = Date.now() + 30_000
            }
        },
    )
    const net = AstalNetwork.get_default()
    net.connect("notify::connectivity", () => {
        if (net.connectivity !== AstalNetwork.Connectivity.FULL) return
        forgiveFailuresUntil = Date.now() + 30_000
        deltaPoll()
    })
}

// -------------------------------------------------------------- startup

// explicit entry point (called from app.tsx): keeps network I/O out of
// module import and makes startup ordering visible
export function init() {
    if (!active) return
    let pending = 2
    let authFailed = false
    const startupDone = () => {
        if (--pending > 0) return
        if (authFailed) {
            authStrikes++ // the whole startup pair is ONE strike
            if (authStrikes >= 2) {
                disableAuth()
                return
            }
        }
        baseline() // also seeds the high-water mark
        slowCycle()
        slowTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30 * 60, () => {
            slowCycle()
            return GLib.SOURCE_CONTINUE
        })
        baselineTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5 * 60, () => {
            baseline()
            return GLib.SOURCE_CONTINUE
        })
        watchLock()
        watchConnectivity()
        armRollover()
        scheduleNext() // delta loop; self-gates until seeded
    }

    request("GET", "/users/me", null, r => {
        if (r.ok && r.json) {
            userId = Number(r.json.id) || 0
            console.log(
                `Harvest: signed in as ${r.json.first_name ?? ""} ${r.json.last_name ?? ""} (account timezone: ${r.json.timezone ?? "unknown"})`,
            )
        }
        authFailed ||= r.authFailed
        startupDone()
    })

    request("GET", "/company", null, r => {
        if (r.ok && r.json) {
            wantsTimestampTimers = !!r.json.wants_timestamp_timers
            accountClock = r.json.clock === "24h" ? "24h" : "12h"
            timeFormat = r.json.time_format === "decimal" ? "decimal" : "hours_minutes"
        } else if (r.status === 403) {
            // company is admin-only on some accounts: use defaults instead
            // of counting this as an auth strike
            console.warn("Harvest: /company not permitted; assuming duration timers + 12h clock")
        } else {
            authFailed ||= r.authFailed
        }
        startupDone()
    })
}
