import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import Soup from "gi://Soup?version=3.0"
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
// and drops the `filter` param from /tasks: filtering moved to the
// dedicated /tasks/filter?query= endpoint)

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

// due.date is YYYY-MM-DD (all-day) or RFC 3339 (timed); overdue =
// strictly before today (local)
export function isOverdue(
    due: { date?: string; datetime?: string } | null,
    nowMs: number,
): boolean {
    if (!due) return false
    const stamp = due.datetime ?? (due.date ? `${due.date}T00:00:00` : null)
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
    const stamp = due.datetime ?? (due.date ? `${due.date}T00:00:00` : null)
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
    if (due.datetime) return `${dayName} · ${d.toTimeString().slice(0, 5)}`
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
    const stamp = raw?.due?.datetime
    if (!id || !content || !stamp) return null
    const ms = Date.parse(stamp)
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

// one-shot banners at (due time − remind_before_minutes). Re-armed
// from every poll: tasks that left the list get cancelled, tasks
// whose due time moved get re-scheduled
const reminderTimers = new Map<string, { src: number; dueMs: number }>()
// id -> due time it already fired for: a recurring task (or an edited
// due time) re-arms, an exact repeat doesn't
const remindedIds = new Map<string, number>()

function fireReminder(item: ProviderItem) {
    remindedIds.set(item.id, item.time * 1000)
    reminderTimers.delete(item.id)
    addProviderPopup(item)
}

// a task the user dealt with (completed/hidden) must not pop its
// armed reminder afterwards
function cancelReminder(id: string) {
    const t = reminderTimers.get(id)
    if (t) {
        sourceRemove(t.src)
        reminderTimers.delete(id)
    }
}

function scheduleReminders(mapped: ProviderItem[]) {
    const present = new Set(mapped.map(i => i.id))
    for (const [id, t] of reminderTimers) {
        if (!present.has(id)) {
            sourceRemove(t.src)
            reminderTimers.delete(id)
        }
    }
    if (!Config.todoist.reminders) return
    for (const item of mapped) {
        const dueMs = item.time * 1000
        const existing = reminderTimers.get(item.id)
        // a re-scheduled task (moved due time) re-arms from scratch
        if (existing && existing.dueMs !== dueMs) {
            sourceRemove(existing.src)
            reminderTimers.delete(item.id)
            remindedIds.delete(item.id)
        } else if (existing || remindedIds.get(item.id) === dueMs) {
            continue
        }
        const delaySec = Math.ceil(
            (dueMs - Config.todoist.remindBeforeMinutes * 60_000 - Date.now()) / 1000,
        )
        if (delaySec <= 0) {
            // the reminder point already passed: banner immediately if
            // the task is still in the future; past-due tasks get no
            // banner (no historical records)
            if (dueMs > Date.now()) fireReminder(item)
            continue
        }
        const src = timeoutAddSeconds("todoist:reminder", GLib.PRIORITY_DEFAULT, delaySec, () => {
            fireReminder(item)
            return GLib.SOURCE_REMOVE
        })
        reminderTimers.set(item.id, { src, dueMs })
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

function applyTasks(rawList: any[]) {
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
    scheduleReminders(mapped)
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
        applyTasks(merged)
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
