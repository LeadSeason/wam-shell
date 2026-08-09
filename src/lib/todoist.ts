import GLib from "gi://GLib?version=2.0"
import AstalNotifd from "gi://AstalNotifd?version=0.1"
import { createState } from "gnim"
import Config from "../config"
import { loadToken } from "./credentials"
import { configHome } from "./paths"
import { createJsonClient, USER_AGENT } from "./httpJson"
import { timeoutAddSeconds, sourceRemove } from "./metrics"
import { Provider, ProviderItem, registerProvider } from "./notificationProviders"
import { addProviderPopup, removePopup, removePopupDeferred } from "./notifd"
import {
    createPollLoop,
    createRefreshGate,
    createSessionHide,
    newArrivals,
    openUrl,
} from "./providerCore"
import { registerDispose } from "./lifecycle"

// re-exported so the unit suite can pin it against Todoist's own
// shapes; the implementation is shared (lib/providerCore)
export { newArrivals }

// Todoist provider for the notification center (API v1): timed tasks
// due today or tomorrow merge into the center's list, and banner when
// their time comes. Action buttons: Mark done completes the task,
// Postpone snoozes the banner locally (snooze_minutes, capped at the
// due time — the remote task is never touched), Dismiss closes the
// banner only (in the center, where there is no banner, it session-
// hides the row). Click opens the task in the browser. Read-only plus
// the complete endpoint; nothing here creates content. Overdue/all-day
// tasks are out of scope: awareness of time-critical tasks, not
// historical records.
// (REST v2 went 410 Gone; v1 paginates with a results/next_cursor
// envelope, drops the task url field — it is constructed from the id —
// drops the `filter` param from /tasks: filtering moved to the
// dedicated /tasks/filter?query= endpoint — and drops due.datetime:
// the due time now lives in due.date itself)

const API = "https://api.todoist.com/api/v1"
const MAX_PAGES = 3 // 150 due/overdue tasks is plenty for a center list

// ---------------------------------------------------------- credentials

const envPath = `${configHome}/todoist.env`

const token = Config.todoist.enabled ? loadToken("Todoist", "TODOIST_API_TOKEN", envPath) : null
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
): Omit<ProviderItem, "dismiss" | "activate" | "hide"> | null {
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
        // a task whose time has come (or gone) is something to act on;
        // one due later today or tomorrow is something to know about.
        // The center sorts the two into its "Needs you" zone and its feed
        actionable: isDueSoon(raw.due ?? null, nowMs),
        url: `https://todoist.com/app/task/${id}`,
    }
}

// overdue, or due within the next hour. The window exists because "due
// at 14:00" stops being informational somewhere before 14:00 — you want
// it in front of you while you can still do something about it
const DUE_SOON_MS = 60 * 60 * 1000

export function isDueSoon(due: { date?: string; datetime?: string } | null, nowMs: number) {
    if (!due) return false
    if (isOverdue(due, nowMs)) return true
    const stamp = dueStamp(due)
    if (!stamp) return false
    const ms = Date.parse(stamp)
    return !Number.isNaN(ms) && ms - nowMs <= DUE_SOON_MS
}

// ---------------------------------------------------------------- http

const request = createJsonClient({
    baseUrl: API,
    logTag: "Todoist",
    headers: () => ({
        Authorization: `Bearer ${token}`,
        "User-Agent": USER_AGENT,
    }),
})

// whether todoist items may raise transient banners: the unified
// opt-in list in [notifications]
const popupsEnabled = () => Config.notifications.popupProviders.includes("todoist")

// ---------------------------------------------------------------- state

const [items, setItems] = createState<ProviderItem[]>([])
export { items }

let pollInFlight = false
let authFailed = false
// stays false until the first successful fetch lands: that fetch is the
// baseline and never banners
let baselineDone = false

// Locally hidden tasks (right-click "dismiss"): session-only, no
// service call — filtered out of every poll so they don't reappear
// before the shell restarts (lib/providerCore owns the mechanism).
//
// Hiding a task means more here than it does for the other providers,
// and the `extra` hook is where that is said out loud: a task the user
// has waved away must not go on popping its armed reminders, and its
// banner has to leave the screen with it. Reached from inside a click on
// the banner, hence the deferred removal.
const hidden = createSessionHide(items, setItems, id => {
    cancelReminder(id)
    removePopupDeferred(id)
})

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
// armed reminders afterwards — nor a pending snooze
function cancelReminder(id: string) {
    for (const [key, t] of reminderTimers) {
        if (t.id === id) {
            sourceRemove(t.src)
            reminderTimers.delete(key)
        }
    }
    const snoozed = snoozeTimers.get(id)
    if (snoozed) {
        sourceRemove(snoozed)
        snoozeTimers.delete(id)
    }
}

// -------------------------------------------------------------- snooze

// Postpone = LOCAL snooze of the banner only: the remote task's due
// time is never touched. The banner re-raises after snooze_minutes,
// capped at the task's due time when that comes first (a task already
// past due snoozes the full duration). Pure so tests can pin the math
export function snoozeDelayMs(dueMs: number, nowMs: number, snoozeMin: number): number {
    const full = snoozeMin * 60_000
    return dueMs > nowMs ? Math.min(full, dueMs - nowMs) : full
}

const snoozeTimers = new Map<string, number>()

// reached from the banner's "Postpone" button, i.e. from inside a click
// on the widget this removes — deferred, see removePopupDeferred
function snooze(item: ProviderItem) {
    removePopupDeferred(item.id)
    const existing = snoozeTimers.get(item.id)
    if (existing) sourceRemove(existing)
    const delayMs = snoozeDelayMs(item.time * 1000, Date.now(), Config.todoist.snoozeMinutes)
    const src = timeoutAddSeconds(
        "todoist:snooze",
        GLib.PRIORITY_DEFAULT,
        Math.ceil(delayMs / 1000),
        () => {
            snoozeTimers.delete(item.id)
            // re-raise with the CURRENT item: a poll may have replaced
            // the object — and a task completed elsewhere gets no banner
            const fresh = items.get().find(i => i.id === item.id)
            if (fresh) addProviderPopup(fresh, AstalNotifd.Urgency.CRITICAL)
            return GLib.SOURCE_REMOVE
        },
    )
    snoozeTimers.set(item.id, src)
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
    const item: ProviderItem = {
        ...data,
        // "Dismiss" on the banner lands here, inside the click
        hide: () => hidden.hide(data.id),
        dismiss: () => complete(data),
        activate: () => openUrl(data.url, "Todoist"),
    }
    // visible buttons on the banner and the center row (the gestures
    // stay as power-user shortcuts). On the banner the host consumes
    // "dismiss": closing the banner must not hide the center row
    item.actions = [
        { id: "done", label: "Mark done", run: () => item.dismiss() },
        {
            id: "postpone",
            label: `Postpone ${Config.todoist.snoozeMinutes}m`,
            run: () => snooze(item),
        },
        { id: "dismiss", label: "Dismiss", run: () => item.hide() },
    ]
    return item
}

// complete the task (POST close → 204): a successful mutation removes
// the item locally instead of waiting for the next poll. Idempotent:
// completing an already-completed task is harmless
function complete(data: Omit<ProviderItem, "dismiss" | "activate" | "hide">) {
    const taskId = data.id.slice("todoist:".length)
    request("POST", `/tasks/${taskId}/close`, r => {
        if (r.ok) {
            cancelReminder(data.id)
            removePopup(data.id)
            setItems(items.get().filter(i => i.id !== data.id))
        } else console.warn(`Todoist: task close failed (status ${r.status})`)
    })
}

function applyTasks(rawList: any[], reminderMap: Map<string, number[]>) {
    const nowMs = Date.now()
    const mapped: ProviderItem[] = []
    for (const raw of rawList) {
        const data = taskData(raw, nowMs)
        if (data && !hidden.has(data.id)) mapped.push(attachActions(data))
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
            loop.stop()
            console.warn(
                `Todoist: token rejected (${r.status}); provider disabled until the shell restarts`,
            )
            return
        }
        // rate limited or overloaded: honour the wait the server asked
        // for instead of re-asking on our own schedule (lib/providerCore
        // owns the rule)
        if (gate.noteBackoff(r, "Todoist", setStatus)) return // keep stale items
        if (!r.ok || !Array.isArray(r.json?.results)) {
            setStatus("Couldn't sync Todoist — retrying next poll")
            return // keep stale items
        }
        gate.clearBackoff()
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
    // the SCHEDULED poll respects the backoff too, not just refresh()
    if (gate.blocked()) return
    pollInFlight = true
    gate.touch()
    fetchTasks("", [])
}

// stale-while-revalidate when the center opens; age-gated so fidgety
// toggling doesn't burn requests
const gate = createRefreshGate(60_000, poll)
export const refresh = gate.refresh

// the fixed-cadence poll (lib/providerCore owns the timer triple)
const loop = createPollLoop("todoist:poll", Config.todoist.pollMinutes, poll)

export function dispose() {
    loop.stop()
    for (const [, t] of reminderTimers) sourceRemove(t.src)
    reminderTimers.clear()
    for (const [, src] of snoozeTimers) sourceRemove(src)
    snoozeTimers.clear()
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
        status,
        setupHint: active
            ? null
            : "Todoist needs an API token: copy it from Todoist → Settings → Integrations → Developer and put it in ~/.config/wam-shell/todoist.env as TODOIST_API_TOKEN=<token>",
    } satisfies Provider)
}

export function init() {
    if (!active) return
    loop.start()
}

// tear-down entry point, run from app.tsx on shutdown (lib/lifecycle)
registerDispose("todoist", dispose)
