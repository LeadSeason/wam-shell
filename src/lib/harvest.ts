import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import Soup from "gi://Soup?version=3.0"
import { createState } from "gnim"
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
    spentDate: string              // "YYYY-MM-DD"
    hours: number
    hoursWithoutTimer: number | null
    timerStartedAt: string | null  // ISO 8601
    startedTime: string | null     // "3:00pm" or "15:00"
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
    tasks: { taskId: number, taskName: string }[]
}

// ---------------------------------------------------------- credentials

interface Credentials { token: string, accountId: string }

function loadCredentials(): Credentials | null {
    const envToken = GLib.getenv("HARVEST_TOKEN")
    const envAccount = GLib.getenv("HARVEST_ACCOUNT_ID")
    if (envToken && envAccount) return { token: envToken, accountId: envAccount }

    const configHome = GLib.getenv("XDG_CONFIG_HOME") || `${GLib.getenv("HOME")}/.config`
    const path = `${configHome}/wam-shell/harvest.env`
    if (!isFile(path)) return null

    // documented chmod 600 is advice; warn when group/other can read it
    try {
        const info = Gio.File.new_for_path(path)
            .query_info("unix::mode", Gio.FileQueryInfoFlags.NONE, null)
        const mode = info.get_attribute_uint32("unix::mode") & 0o777
        if (mode & 0o077) {
            console.warn(`Harvest: ${path} is readable by group/other (mode ${mode.toString(8)}); consider chmod 600`)
        }
    } catch { }

    let token = "", accountId = ""
    try {
        const contents = GLib.file_get_contents(path)[1]
        const text = new TextDecoder().decode(contents)
        for (const line of text.split("\n")) {
            const m = line.match(/^\s*(HARVEST_TOKEN|HARVEST_ACCOUNT_ID)\s*=\s*"?([^"\n]+)"?\s*$/)
            if (!m) continue
            if (m[1] === "HARVEST_TOKEN") token = m[2].trim()
            else accountId = m[2].trim()
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
    console.log("Harvest: enabled but no credentials (env HARVEST_TOKEN/HARVEST_ACCOUNT_ID or ~/.config/wam-shell/harvest.env); widget disabled")
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
const [ready, setReady] = createState(false)
export { ready }

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
        const m = e.startedTime.trim().match(/^(\d{1,2}):(\d{2})\s*([ap])\.?m\.?$/i)
            ?? e.startedTime.trim().match(/^(\d{1,2}):(\d{2})$/)
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
    const base = (e.hoursWithoutTimer ?? e.hours ?? 0) * 3600
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
            "wam-shell", 0, "dialog-warning-symbolic", summary, body, [],
            { urgency: new GLib.Variant("y", 2) }, -1,
        ]),
        null, Gio.DBusCallFlags.NONE, -1, null,
        (_conn, res) => {
            try { Gio.DBus.session.call_finish(res) }
            catch (e) { console.warn("harvest notify failed:", e) }
        },
    )
}

// ---------------------------------------------------------------- http

const session = new Soup.Session({ timeout: 20 })

interface Reply {
    ok: boolean         // 2xx with parseable body (or no body needed)
    authFailed: boolean // 401/403
    status: number
    json: any
    retryAfter: number  // seconds, from 429 responses (0 = absent)
}

// never log anything beyond method + path + status: headers carry the token
function request(method: string, path: string, body: any, cb: (r: Reply) => void) {
    const msg = Soup.Message.new(method, `${BASE}${path}`)
    if (!msg) { cb({ ok: false, authFailed: false, status: 0, json: null, retryAfter: 0 }); return }
    const h = msg.get_request_headers()
    h.append("Authorization", `Bearer ${creds!.token}`)
    h.append("Harvest-Account-Id", creds!.accountId)
    h.append("User-Agent", UA)
    if (body !== null && body !== undefined) {
        const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body)))
        msg.set_request_body_from_bytes("application/json", bytes)
    }
    let cancelled = false
    const cancellable = new Gio.Cancellable()
    pendingRequests.add(cancellable)
    session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (_s, res) => {
        pendingRequests.delete(cancellable)
        if (cancelled) return
        let reply: Reply
        try {
            const bytes = session.send_and_read_finish(res)
            const text = bytes ? new TextDecoder().decode(bytes.get_data() ?? new Uint8Array()) : ""
            let json: any = null
            try { json = text ? JSON.parse(text) : null } catch { }
            const status = msg.get_status()
            const retryAfter = status === 429
                ? Number(msg.get_response_headers().get_one("Retry-After")) || 0
                : 0
            reply = {
                ok: status >= 200 && status < 300,
                authFailed: status === 401 || status === 403,
                status, json, retryAfter,
            }
        } catch (e) {
            reply = { ok: false, authFailed: false, status: 0, json: null, retryAfter: 0 }
        }
        if (!reply.ok && !reply.authFailed) {
            console.warn(`Harvest: ${method} ${path} -> ${reply.status || "network error"}`)
        }
        cb(reply)
    })
    return {
        cancel: () => { cancelled = true; cancellable.cancel() },
    }
}

const pendingRequests = new Set<Gio.Cancellable>()

// follow links.next until exhausted (cursor- and page-based endpoints alike)
function fetchAll(path: string, key: string, acc: any[], cb: (items: any[] | null, r: Reply) => void) {
    request("GET", path, null, (r) => {
        if (!r.ok || !r.json) { cb(r.ok ? acc : null, r); return }
        const items = acc.concat(r.json[key] ?? [])
        const next: string | null = r.json.links?.next ?? null
        if (next && next.startsWith(BASE)) fetchAll(next.slice(BASE.length), key, items, cb)
        else cb(items, r)
    })
}

// ------------------------------------------------------- polling engine

let fastTimer = 0
let slowTimer = 0
let tickerSource = 0
let authStrikes = 0
let backoffLevel = 0
let cycleGen = 0

const BACKOFF_CAP = 600 // seconds

function fastDelay(): number {
    const base = Config.harvest.pollInterval * Math.pow(2, backoffLevel)
    return Math.min(base, BACKOFF_CAP)
}

function cycleDone(authFailed: boolean, failed: boolean, retryAfter = 0) {
    if (authFailed) {
        // one strike per cycle, not per request: a bad token fails every
        // request in the batch from one cause
        authStrikes++
        if (authStrikes >= 2) disableAuth()
    } else {
        authStrikes = 0
    }
    if (failed) backoffLevel = Math.min(backoffLevel + 1, 5)
    else backoffLevel = 0

    if (authDisabled.get()) return
    const delay = Math.max(retryAfter, fastDelay())
    if (fastTimer) GLib.source_remove(fastTimer)
    fastTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
        fastTimer = 0
        fastCycle()
        return GLib.SOURCE_REMOVE
    })
}

function fastCycle() {
    if (!active || authDisabled.get()) return
    // generation guard: responses from an older cycle land after a
    // mutation-triggered cycle and must not overwrite its fresher state
    const gen = ++cycleGen
    let pending = 2
    let authFailed = false
    let failed = false
    let retryAfter = 0
    const done = (r: Reply) => {
        if (gen !== cycleGen) return
        authFailed ||= r.authFailed
        failed ||= !r.ok
        retryAfter = Math.max(retryAfter, r.retryAfter)
        if (--pending === 0) cycleDone(authFailed, failed, retryAfter)
    }

    // authoritative running probe: unbounded in time, the only query that
    // always sees a timer left running over a weekend
    request("GET", "/time_entries?is_running=true", null, (r) => {
        if (gen !== cycleGen) return
        if (r.ok && r.json) adoptRunning((r.json.time_entries ?? [])[0] ?? null)
        done(r)
    })

    // day total + resume target; ±1d widening keeps spent_date tz-safe
    request("GET", `/time_entries?from=${localDay(-1)}&to=${localDay(1)}`, null, (r) => {
        if (gen !== cycleGen) return
        if (r.ok && r.json) adoptWindow((r.json.time_entries ?? []).map(mapEntry))
        done(r)
    })
}

function slowCycle() {
    if (!active || authDisabled.get()) return
    let pending = 2
    const done = () => { if (--pending > 0) return }
    // near-static: projects + tasks for the picker (cursor-paginated)
    fetchAll("/users/me/project_assignments", "project_assignments", [], (items, _r) => {
        if (items) {
            setProjects(items.map((a: any): Project => ({
                projectId: a.project?.id ?? 0,
                projectName: a.project?.name ?? "",
                clientName: a.client?.name ?? "",
                tasks: (a.task_assignments ?? [])
                    .filter((t: any) => t.is_active !== false)
                    .map((t: any) => ({
                        taskId: t.task?.id ?? 0,
                        taskName: t.task?.name ?? "",
                    })),
            })))
        }
        done()
    })
    // wide window for the dropdown's recent project/task pairs
    fetchAll(`/time_entries?from=${localDay(-30)}&to=${localDay(1)}`, "time_entries", [], (items, _r) => {
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
        done()
    })
}

function adoptRunning(raw: any) {
    const prev = running.get()
    const next = raw ? mapEntry(raw) : null
    setRunning(next)
    if (next) {
        // a timer running means nothing is paused anymore
        setPaused(null)
        // keep ticking from the server's numbers, not our stale ones
        setElapsed(liveSeconds(next))
        armTicker()
    } else {
        setElapsed(0)
        disarmTicker()
    }
    if (prev?.id !== next?.id) refreshDayTotal()
}

let stoppedTodaySec = 0

function adoptWindow(entries: Entry[]) {
    const today = localDay()
    const todays = entries.filter(e => e.spentDate === today)
    stoppedTodaySec = todays.filter(e => !e.isRunning)
        .reduce((sum, e) => sum + e.hours * 3600, 0)
    refreshDayTotal()
    const stopped = todays
        .filter(e => !e.isRunning && e.updatedAt)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
    setLastStopped(stopped)
}

function refreshDayTotal() {
    setDayTotal(stoppedTodaySec + (running.get() ? elapsed.get() : 0))
}

// 1s local ticker: the panel clock costs no API calls
function armTicker() {
    if (tickerSource) return
    tickerSource = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
        const cur = running.get()
        if (!cur) { tickerSource = 0; return GLib.SOURCE_REMOVE }
        setElapsed(liveSeconds(cur))
        refreshDayTotal()
        return GLib.SOURCE_CONTINUE
    })
}

function disarmTicker() {
    if (tickerSource) {
        GLib.source_remove(tickerSource)
        tickerSource = 0
    }
}

function disableAuth() {
    if (authDisabled.get()) return
    setAuthDisabled(true)
    if (fastTimer) { GLib.source_remove(fastTimer); fastTimer = 0 }
    if (slowTimer) { GLib.source_remove(slowTimer); slowTimer = 0 }
    console.warn("Harvest: disabling after repeated authentication failures")
    notify("Harvest authentication failed",
        "Check ~/.config/wam-shell/harvest.env — the widget is disabled until the shell restarts.")
}

// ------------------------------------------------------------- actions
// serialized: one mutation in flight, further clicks ignored while busy;
// the poll backoff never applies here, clicks fire immediately

let mutInFlight = false

function mutate(work: (done: () => void) => void) {
    if (mutInFlight || authDisabled.get()) return
    mutInFlight = true
    setBusy(true)
    work(() => {
        mutInFlight = false
        setBusy(false)
        fastCycle()
    })
}

export function stopRunning() {
    const cur = running.get()
    if (!cur) return
    mutate((done) => {
        request("PATCH", `/time_entries/${cur.id}/stop`, null, (r) => {
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
    mutate((done) => {
        request("PATCH", `/time_entries/${cur.id}/stop`, null, (r) => {
            if (r.ok && r.json) {
                setPaused(mapEntry(r.json))
                adoptRunning(null)
            } else console.warn(`Harvest: pause failed (status ${r.status})`)
            done()
        })
    })
}

function createEntry(projectId: number, taskId: number, done: (ok: boolean) => void) {
    const body: Record<string, any> = {
        project_id: projectId,
        task_id: taskId,
        spent_date: localDay(),
    }
    // timestamp accounts: started_time defaults to now, ended_time omitted
    // leaves it running; duration accounts: no hours = running
    if (wantsTimestampTimers) {
        const fmt = accountClock === "24h" ? "%H:%M" : "%-I:%M%p"
        body.started_time = GLib.DateTime.new_now_local().format(fmt)!
            .toLowerCase()
    }
    request("POST", "/time_entries", body, (r) => {
        if (r.ok && r.json) adoptRunning(r.json)
        done(r.ok)
    })
}

export function startTimer(projectId: number, taskId: number) {
    // single call: verified against the live API that POST auto-stops the
    // currently running entry, so no stop-first / rollback dance is needed
    mutate((done) => {
        createEntry(projectId, taskId, () => done())
    })
}

// Harvest's native resume. Verified against the live API: restart keeps
// the same entry id (hours accumulate on the same row); the response body
// is adopted as-is either way
export function resumeEntry(entry: Entry) {
    if (entry.isRunning) return
    mutate((done) => {
        request("PATCH", `/time_entries/${entry.id}/restart`, null, (r) => {
            if (r.ok && r.json) adoptRunning(r.json)
            else console.warn(`Harvest: restart failed (status ${r.status})`)
            done()
        })
    })
}

export function resumeLast() {
    const target = paused.get() ?? lastStopped.get() ?? recents.get()[0] ?? null
    if (target) resumeEntry(target)
}

export function setNotes(text: string) {
    const cur = running.get()
    if (!cur) return
    mutate((done) => {
        request("PATCH", `/time_entries/${cur.id}`, { notes: text }, (r) => {
            if (r.ok && r.json) adoptRunning(r.json)
            else console.warn(`Harvest: notes update failed (status ${r.status})`)
            done()
        })
    })
}

// stale-while-revalidate when the quick settings dropdown opens
export function refreshSlow() {
    slowCycle()
}

// -------------------------------------------------------------- startup

if (active) {
    let pending = 2
    let authFailed = false
    const startupDone = () => {
        if (--pending > 0) return
        if (authFailed) {
            authStrikes++ // the whole startup pair is ONE strike
            if (authStrikes >= 2) { disableAuth(); return }
        }
        setReady(true)
        fastCycle()
        slowCycle()
        slowTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30 * 60, () => {
            slowCycle()
            return GLib.SOURCE_CONTINUE
        })
    }

    request("GET", "/users/me", null, (r) => {
        if (r.ok && r.json) {
            console.log(`Harvest: signed in as ${r.json.first_name ?? ""} ${r.json.last_name ?? ""} (account timezone: ${r.json.timezone ?? "unknown"})`)
        }
        authFailed ||= r.authFailed
        startupDone()
    })

    request("GET", "/company", null, (r) => {
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
