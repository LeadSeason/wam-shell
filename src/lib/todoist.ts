import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import Soup from "gi://Soup?version=3.0"
import AstalNotifd from "gi://AstalNotifd?version=0.1"
import { createState } from "gnim"
import Config from "../config"
import { isFile } from "./utils"
import { timeoutAddSeconds, sourceRemove, trackHttp } from "./metrics"
import { Provider, ProviderItem, registerProvider } from "./notificationProviders"
import { addProviderPopup } from "./notifd"

// Todoist provider for the notification center (API v1): timed tasks
// due today or tomorrow merge into the center's list, and banner when
// their time comes. Click opens the task in the browser, dismiss
// completes it on Todoist. Read-only plus the complete endpoint;
// nothing here creates content. Overdue/all-day tasks are out of
// scope: awareness of time-critical tasks, not historical records.
// (REST v2 went 410 Gone; v1 paginates with a results/next_cursor
// envelope, drops the task url field — it is constructed from the id —
// drops the `filter` param from /tasks: filtering moved to the
// dedicated /tasks/filter?query= endpoint — and drops due.datetime:
// the due time now lives in due.date itself)

const API = "https://api.todoist.com/api/v1"
const UA = "wam-shell (https://github.com/LeadSeason/wam-shell)"
const MAX_PAGES = 3 // 150 due/overdue tasks is plenty for a center list

// ---------------------------------------------------------- credentials

const configHome = `${GLib.getenv("XDG_CONFIG_HOME") || `${GLib.getenv("HOME")}/.config`}/wam-shell`
const envPath = `${configHome}/todoist.env`

function loadToken(): string | null {
    const envToken = GLib.getenv("TODOIST_API_TOKEN")
    if (envToken) return envToken

    if (!isFile(envPath)) return null

    // documented chmod 600 is advice; warn when group/other can read it
    try {
        const info = Gio.File.new_for_path(envPath).query_info(
            "unix::mode",
            Gio.FileQueryInfoFlags.NONE,
            null,
        )
        const mode = info.get_attribute_uint32("unix::mode") & 0o777
        if (mode & 0o077) {
            console.warn(
                `Todoist: ${envPath} is readable by group/other (mode ${mode.toString(8)}); consider chmod 600`,
            )
        }
    } catch (e) {
        console.warn("Todoist: could not stat credentials file:", e)
    }

    try {
        const contents = GLib.file_get_contents(envPath)[1]
        const text = new TextDecoder().decode(contents)
        for (const line of text.split("\n")) {
            const m = line.match(/^\s*(?:export\s+)?TODOIST_API_TOKEN\s*=\s*(.+?)\s*$/)
            if (!m) continue
            // tolerate inline comments and single/double quotes
            return m[1].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "")
        }
    } catch (e) {
        console.warn("Todoist: failed reading credentials file:", e)
    }
    return null
}

const token = Config.todoist.enabled ? loadToken() : null
// the center gates on the registry; this gates the registry
export const active = Config.todoist.enabled && token !== null
if (Config.todoist.enabled && !token) {
    console.log(
        "Todoist: enabled but no token (env TODOIST_API_TOKEN or ~/.config/wam-shell/todoist.env); provider disabled",
    )
}

// ------------------------------------------------- pure mapping (tests)

// v1 due shape: due.date is "YYYY-MM-DD" for all-day tasks and
// "YYYY-MM-DDTHH:MM:SS" (floating local) for timed ones — the v2
// due.datetime field is gone (kept as a fallback below in case the
// API reintroduces it)
function dueStamp(due: any): string | null {
    if (due?.datetime) return due.datetime
    const d = due?.date
    if (typeof d !== "string") return null
    return d.includes("T") ? d : `${d}T00:00:00`
}

// a task counts as timed when its due carries a real clock time
function isTimed(due: any): boolean {
    return !!due?.datetime || (typeof due?.date === "string" && due.date.includes("T"))
}

// due.date is YYYY-MM-DD (all-day) or RFC 3339 (timed); overdue =
// strictly before today (local)
export function isOverdue(
    due: { date?: string; datetime?: string } | null,
    nowMs: number,
): boolean {
    const stamp = dueStamp(due)
    if (!stamp) return false
    const ms = Date.parse(stamp)
    if (Number.isNaN(ms)) return false
    const today = new Date(nowMs)
    today.setHours(0, 0, 0, 0)
    return ms < today.getTime()
}

export function dueLabel(due: any, nowMs: number): string {
    if (!due) return ""
    if (isOverdue(due, nowMs)) return `Overdue · ${due.string ?? due.date ?? ""}`
    const stamp = dueStamp(due)
    if (!stamp) return ""
    const d = new Date(Date.parse(stamp))
    if (Number.isNaN(d.getTime())) return ""
    const today = new Date(nowMs)
    today.setHours(0, 0, 0, 0)
    const dueDay = new Date(d)
    dueDay.setHours(0, 0, 0, 0)
    const diffDays = Math.round((dueDay.getTime() - today.getTime()) / 86_400_000)
    // beyond tomorrow (shouldn't happen with the poll query): fall back
    // to the API's own rendering
    const dayName = diffDays === 0 ? "Today" : diffDays === 1 ? "Tomorrow" : (due.string ?? "")
    if (isTimed(due)) return `${dayName} · ${d.toTimeString().slice(0, 5)}`
    return dayName
}

// the data half of a ProviderItem; actions are attached by the module
// (they close over the poll state). Only TIMED tasks (a concrete due
// time) are listed — all-day tasks are out of scope by design (user
// decision: notifications are for timed tasks only). null = unusable
// task shape or no due time.
// v1 drops the url field: the web link is /app/task/<id>
export function taskData(
    raw: any,
    nowMs: number,
): Omit<ProviderItem, "dismiss" | "activate"> | null {
    const id = raw?.id
    const content = raw?.content
    if (!id || !content || !isTimed(raw?.due)) return null
    const stamp = dueStamp(raw.due)
    const ms = Date.parse(stamp!)
    return {
        id: `todoist:${id}`,
        provider: "todoist",
        time: Number.isNaN(ms) ? nowMs / 1000 : ms / 1000,
        appName: "Todoist",
        summary: content,
        body: dueLabel(raw.due ?? null, nowMs),
        iconName: "todoist-symbolic",
        url: `https://todoist.com/app/task/${id}`,
    }
}

// ids in next but not in prev. Brand-new tasks only: a task that was
// already due keeps its id and stays quiet
export function newArrivals(prev: { id: string }[], next: { id: string }[]): string[] {
    const prevIds = new Set(prev.map(i => i.id))
    return next.filter(i => !prevIds.has(i.id)).map(i => i.id)
}

// ---------------------------------------------------------------- http

const session = new Soup.Session({ timeout: 20 })

interface Reply {
    ok: boolean // 2xx
    status: number
    json: any
}

// never log anything beyond method + path + status: the token is a secret
function request(method: string, path: string, cb: (r: Reply) => void) {
    const url = `${API}${path}`
    const msg = Soup.Message.new(method, url)
    if (!msg) {
        cb({ ok: false, status: 0, json: null })
        return
    }
    const h = msg.get_request_headers()
    h.append("Authorization", `Bearer ${token}`)
    h.append("User-Agent", UA)
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
                `Todoist: ${method} ${path.split("?")[0]} -> ${reply.status || "network error"}`,
            )
        cb(reply)
    })
}

// whether todoist items may raise transient banners: the unified
// opt-in list in [notifications]
const popupsEnabled = () => Config.notifications.popupProviders.includes("todoist")

// ---------------------------------------------------------------- state

const [items, setItems] = createState<ProviderItem[]>([])
export { items }

let pollInFlight = false
let lastPollAttempt = 0
let authFailed = false
let pollTimer = 0
// stays false until the first successful fetch lands: that fetch is the
// baseline and never banners
let baselineDone = false

// locally hidden tasks (right-click "dismiss"): session-only, no
// service call — filtered out of every poll so they don't reappear
// before the shell restarts
const hiddenIds = new Set<string>()

// ------------------------------------------------------- due reminders

// banners fire TWICE per task: at the task's own Todoist reminder
// (relative "30 min before" or absolute — the API precomputes the
// fire time into the reminder's due.date) and again at the actual due
// moment. Tasks without a reminder fall back to (due −
// remind_before_minutes) for the first banner. Re-armed from every
// poll: tasks that left the list get cancelled, tasks whose due time
// moved get re-scheduled.
// Pure so tests can pin the mapping. item_id → sorted fire times (ms)
export function buildReminderMap(rawList: any[]): Map<string, number[]> {
    const map = new Map<string, number[]>()
    for (const r of rawList) {
        if (r?.is_deleted) continue
        const taskId = r?.item_id
        const stamp = r?.due?.datetime ?? r?.due?.date
        if (!taskId || typeof stamp !== "string") continue
        const ms = Date.parse(stamp)
        if (Number.isNaN(ms)) continue
        map.set(taskId, [...(map.get(taskId) ?? []), ms])
    }
    for (const fires of map.values()) fires.sort((a, b) => a - b)
    return map
}

// timers keyed `${item.id}|${fireMs}` so a task can carry several
// reminders; dueMs is the task's due time for re-arm detection
const reminderTimers = new Map<string, { src: number; id: string; dueMs: number }>()
// keys that already fired: an edited due time (or edited reminder)
// produces a new key and re-arms, an exact repeat doesn't
const remindedKeys = new Set<string>()

function fireReminder(key: string, item: ProviderItem) {
    remindedKeys.add(key)
    reminderTimers.delete(key)
    // due reminders are time-critical: the banner never auto-hides
    // and breaks through DND, like an alarm clock
    addProviderPopup(item, AstalNotifd.Urgency.CRITICAL)
}

// a task the user dealt with (completed/hidden) must not pop its
// armed reminders afterwards
function cancelReminder(id: string) {
    for (const [key, t] of reminderTimers) {
        if (t.id === id) {
            sourceRemove(t.src)
            reminderTimers.delete(key)
        }
    }
}

function scheduleReminders(mapped: ProviderItem[], reminderMap: Map<string, number[]>) {
    const byId = new Map(mapped.map(i => [i.id, i]))
    // cancel timers for tasks that left the list or whose due moved
    for (const [key, t] of reminderTimers) {
        const item = byId.get(t.id)
        if (!item || item.time * 1000 !== t.dueMs) {
            sourceRemove(t.src)
            reminderTimers.delete(key)
        }
    }
    if (!Config.todoist.reminders) return
    for (const item of mapped) {
        const dueMs = item.time * 1000
        // first banner: the task's Todoist reminder(s), or the
        // remind_before_minutes fallback; second banner: at due. The
        // set dedupes a reminder set exactly at the due time
        const fires = new Set(
            reminderMap.get(item.id.slice("todoist:".length)) ?? [
                dueMs - Config.todoist.remindBeforeMinutes * 60_000,
            ],
        )
        fires.add(dueMs)
        for (const fireMs of fires) {
            const key = `${item.id}|${fireMs}`
            if (reminderTimers.has(key) || remindedKeys.has(key)) continue
            const delaySec = Math.ceil((fireMs - Date.now()) / 1000)
            if (delaySec <= 0) {
                // the fire point passed while we weren't looking:
                // banner only while the task is still in the future;
                // past-due tasks get no banner (no historical records)
                if (dueMs > Date.now()) fireReminder(key, item)
                continue
            }
            const src = timeoutAddSeconds(
                "todoist:reminder",
                GLib.PRIORITY_DEFAULT,
                delaySec,
                () => {
                    fireReminder(key, item)
                    return GLib.SOURCE_REMOVE
                },
            )
            reminderTimers.set(key, { src, id: item.id, dueMs })
        }
    }
}

function attachActions(data: Omit<ProviderItem, "dismiss" | "activate" | "hide">): ProviderItem {
    return {
        ...data,
        hide: () => {
            hiddenIds.add(data.id)
            cancelReminder(data.id)
            setItems(items.get().filter(i => i.id !== data.id))
        },
        dismiss: () => complete(data),
        activate: () => {
            Gio.AppInfo.launch_default_for_uri_async(data.url, null, null, (_s, res) => {
                try {
                    Gio.AppInfo.launch_default_for_uri_finish(res)
                } catch (e) {
                    console.warn("Todoist: could not open the browser:", e)
                }
            })
        },
    }
}

// complete the task (POST close → 204): a successful mutation removes
// the item locally instead of waiting for the next poll. Idempotent:
// completing an already-completed task is harmless
function complete(data: Omit<ProviderItem, "dismiss" | "activate" | "hide">) {
    const taskId = data.id.slice("todoist:".length)
    request("POST", `/tasks/${taskId}/close`, r => {
        if (r.ok) {
            cancelReminder(data.id)
            setItems(items.get().filter(i => i.id !== data.id))
        } else console.warn(`Todoist: task close failed (status ${r.status})`)
    })
}

function applyTasks(rawList: any[], reminderMap: Map<string, number[]>) {
    const nowMs = Date.now()
    const mapped: ProviderItem[] = []
    for (const raw of rawList) {
        const data = taskData(raw, nowMs)
        if (data && !hiddenIds.has(data.id)) mapped.push(attachActions(data))
    }
    // soonest due first
    mapped.sort((a, b) => a.time - b.time)
    const prev = items.get()
    setItems(mapped)
    scheduleReminders(mapped, reminderMap)
    if (!baselineDone) {
        // the first fetch after startup is the baseline: bannering the
        // whole backlog would spam the screen
        baselineDone = true
        return
    }
    if (!popupsEnabled()) return
    for (const id of newArrivals(prev, mapped)) {
        const item = mapped.find(i => i.id === id)
        if (item) addProviderPopup(item)
    }
}

// surfaced in the center's empty state while unhealthy
const [status, setStatus] = createState<string | null>(null)

function fetchTasks(cursor: string, acc: any[]) {
    // the filter query needs encoding: "today | tomorrow" (tomorrow is
    // included so its scheduled tasks get reminders). Overdue is
    // deliberately absent: the provider is about time-critical tasks,
    // not historical records. v1 removed `filter` from /tasks (it
    // silently pages the whole backlog); the dedicated endpoint honors
    // the query
    const q = cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
    request("GET", `/tasks/filter?query=today%20%7C%20tomorrow${q}`, r => {
        pollInFlight = false
        if (r.status === 401 || r.status === 403) {
            authFailed = true
            setStatus("Todoist token rejected — check ~/.config/wam-shell/todoist.env")
            if (pollTimer) {
                sourceRemove(pollTimer)
                pollTimer = 0
            }
            console.warn(
                `Todoist: token rejected (${r.status}); provider disabled until the shell restarts`,
            )
            return
        }
        if (!r.ok || !Array.isArray(r.json?.results)) {
            setStatus("Couldn't sync Todoist — retrying next poll")
            return // keep stale items
        }
        setStatus(null)
        const merged = acc.concat(r.json.results)
        // v1 paginates at 50 via next_cursor; a cursor means more pages
        if (r.json.next_cursor && merged.length < MAX_PAGES * 50) {
            pollInFlight = true
            fetchTasks(r.json.next_cursor, merged)
            return
        }
        fetchReminders(merged)
    })
}

// each task's own Todoist reminder drives its banner time; a failed
// fetch degrades to the remind_before_minutes fallback, not to silence
function fetchReminders(taskList: any[]) {
    request("GET", "/reminders", r => {
        const map =
            r.ok && Array.isArray(r.json?.results) ? buildReminderMap(r.json.results) : new Map()
        applyTasks(taskList, map)
    })
}

export function poll() {
    if (!active || authFailed || pollInFlight) return
    pollInFlight = true
    lastPollAttempt = Date.now()
    fetchTasks("", [])
}

// stale-while-revalidate when the center opens; age-gated so fidgety
// toggling doesn't burn requests
export function refresh() {
    if (Date.now() - lastPollAttempt < 60_000) return
    poll()
}

export function dispose() {
    if (pollTimer) {
        sourceRemove(pollTimer)
        pollTimer = 0
    }
    for (const [, t] of reminderTimers) sourceRemove(t.src)
    reminderTimers.clear()
}

// -------------------------------------------------------------- startup

// registry presence must not depend on network: the provider registers
// at import (the center reads it whenever its lazy window is built),
// network only starts in init() from app.tsx
if (Config.todoist.enabled) {
    registerProvider({
        name: "todoist",
        iconName: "todoist-symbolic",
        displayName: "Todoist",
        items,
        refresh,
        dispose,
        status,
        setupHint: active
            ? null
            : "Todoist needs an API token: copy it from Todoist → Settings → Integrations → Developer and put it in ~/.config/wam-shell/todoist.env as TODOIST_API_TOKEN=<token>",
    } satisfies Provider)
}

export function init() {
    if (!active) return
    poll()
    pollTimer = timeoutAddSeconds(
        "todoist:poll",
        GLib.PRIORITY_DEFAULT,
        Config.todoist.pollMinutes * 60,
        () => {
            poll()
            return GLib.SOURCE_CONTINUE
        },
    )
}
