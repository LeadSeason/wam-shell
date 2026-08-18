import GLib from "gi://GLib?version=2.0"
import AstalNotifd from "gi://AstalNotifd?version=0.1"
import { createState } from "gnim"
import Config from "../config"
import {
    CalEvent,
    accountEmails,
    authenticate,
    dayKey,
    dayLabel,
    refresh,
    timeLabel,
    visibleEvents,
} from "./gcal"
import { Provider, ProviderItem, registerProvider } from "./notificationProviders"
import { addProviderPopup, removePopupDeferred } from "./notifd"
import { createSessionHide, openUrl } from "./providerCore"
import { timeoutAddSeconds, sourceRemove } from "./metrics"
import { registerDispose } from "./lifecycle"

// Calendar event reminders and the notification center's "calendar"
// provider. Owns no network: it subscribes to gcal's visibleEvents and
// re-derives everything from each sync (and each visibility toggle —
// picker-hidden calendars neither list nor banner).
//
// Banners fire at the event's own Google reminder times (per-event
// overrides, else the calendar's defaults, else the config fallback
// remind_before_minutes — resolution lives in lib/gcal.ts) and again
// when the event starts. Reminders are time-critical: the banner is
// CRITICAL — it never auto-hides and breaks through DND, like an alarm
// clock (the todoist due-reminder policy). Events Google explicitly
// marks reminder-less stay silent; all-day events are out of scope
// (same call as todoist's all-day tasks). Banners are also limited to
// events the account actually ATTENDS (guest list, organizer, or a
// personal event — resolution lives in lib/gcal.ts) unless the config
// opts back into bannering everything a visible calendar shows
// (remind_only_attending); the center lists them either way.
//
// The center lists today's and tomorrow's timed events; starting-soon
// and in-progress ones are `actionable` and sit in the "Needs you"
// zone. Registration at import also backs middle-click banner snooze:
// notifd's unsnooze re-finds the fresh item in this provider's items.

// ---------------------------------------------------------------- state

const [items, setItems] = createState<ProviderItem[]>([])
export { items }

// an event the user waved away must not reappear before the shell
// restarts, must not pop its armed reminders, and its banner leaves the
// screen with it (reached from inside a click — hence the deferred
// removal). The mechanism is shared (lib/providerCore)
const hidden = createSessionHide(items, setItems, id => {
    cancelReminder(id)
    removePopupDeferred(id)
})

// ------------------------------------------------- pure mapping (tests)

// the data half of a ProviderItem; actions are attached by the module
// (they close over the session-hide state)
export function eventItemData(
    e: CalEvent,
    nowMs: number,
): Omit<ProviderItem, "dismiss" | "activate" | "hide"> {
    return {
        id: `gcal:${e.id}`,
        provider: "calendar",
        time: e.startMs / 1000,
        appName: e.calendarName,
        summary: e.summary,
        body: `${dayLabel(dayKey(e.startMs), dayKey(nowMs))} · ${timeLabel(e)}`,
        iconName: "x-office-calendar-symbolic",
        // starting within the lead time, or in progress right now: it
        // needs you. A zero-length event that already started needs
        // nothing — now < endMs is false for it
        actionable:
            nowMs < e.endMs && e.startMs - nowMs <= Config.calendar.remindBeforeMinutes * 60_000,
        url: e.url,
    }
}

// every banner fire point of an event, ms epochs. null reminderMinutes
// = explicitly silent, no banner at all (not even at start); [] = no
// information, the config fallback steps in. The start itself is always
// a fire point for non-silent events; the Set dedupes a reminder set
// exactly at the start
export function reminderFires(e: CalEvent, fallbackMinutes: number): number[] {
    if (e.reminderMinutes === null) return []
    const fires = new Set(
        (e.reminderMinutes.length > 0 ? e.reminderMinutes : [fallbackMinutes]).map(
            m => e.startMs - m * 60_000,
        ),
    )
    fires.add(e.startMs)
    return [...fires]
}

// ----------------------------------------------------------- reminders

// timers keyed `${itemId}|${fireMs}` so an event can carry several
// reminders; startMs is the event's start for re-arm detection (a moved
// event produces new keys and its old timers are cancelled)
const reminderTimers = new Map<string, { src: number; id: string; startMs: number }>()
// keys that already fired: an edited start time (or edited reminders)
// produces a new key and re-arms, an exact repeat doesn't
const remindedKeys = new Set<string>()

function fireReminder(key: string, id: string) {
    remindedKeys.add(key)
    reminderTimers.delete(key)
    // the FRESH item: a sync may have replaced the object, and a hidden
    // event gets no banner
    const item = items.get().find(i => i.id === id)
    if (item) addProviderPopup(item, AstalNotifd.Urgency.CRITICAL)
}

function cancelReminder(id: string) {
    for (const [key, t] of reminderTimers) {
        if (t.id === id) {
            sourceRemove(t.src)
            reminderTimers.delete(key)
        }
    }
}

function scheduleReminders(list: CalEvent[]) {
    const byItemId = new Map(list.map(e => [`gcal:${e.id}`, e]))
    // cancel timers for events that left the list or whose start moved
    for (const [key, t] of reminderTimers) {
        const e = byItemId.get(t.id)
        if (!e || e.startMs !== t.startMs) {
            sourceRemove(t.src)
            reminderTimers.delete(key)
        }
    }
    if (!Config.calendar.reminders) return
    for (const e of list) {
        const id = `gcal:${e.id}`
        if (hidden.has(id)) continue
        // an event the account merely SEES (a shared calendar's, with
        // no guest entry of yours) gets no banner unless the config
        // opts back in — the center lists it either way
        if (Config.calendar.remindOnlyAttending && !e.attending) continue
        for (const fireMs of reminderFires(e, Config.calendar.remindBeforeMinutes)) {
            const key = `${id}|${fireMs}`
            if (reminderTimers.has(key) || remindedKeys.has(key)) continue
            const delaySec = Math.ceil((fireMs - Date.now()) / 1000)
            if (delaySec <= 0) {
                // the fire point passed while we weren't looking: banner
                // only while the event is still in the future; a start
                // that already happened gets no banner (no historical
                // records)
                if (e.startMs > Date.now()) fireReminder(key, id)
                continue
            }
            const src = timeoutAddSeconds("gcal:reminder", GLib.PRIORITY_DEFAULT, delaySec, () => {
                fireReminder(key, id)
                return GLib.SOURCE_REMOVE
            })
            reminderTimers.set(key, { src, id, startMs: e.startMs })
        }
    }
}

// -------------------------------------------------------------- rebuild

function attachActions(data: Omit<ProviderItem, "dismiss" | "activate" | "hide">): ProviderItem {
    return {
        ...data,
        hide: () => hidden.hide(data.id),
        // there is no remote "done" for an event: dismiss is the same
        // session hide (the banner host consumes "dismiss" for closing)
        dismiss: () => hidden.hide(data.id),
        activate: () => {
            if (data.url) openUrl(data.url, "Calendar")
        },
    }
}

// items and armed reminders both derive from the visible events of
// today/tomorrow. Ended events leave the list (awareness of what's
// coming, not historical records); multi-day timed events stay while
// they still touch the horizon
function rebuild(list: CalEvent[]) {
    const nowMs = Date.now()
    const d = new Date(nowMs)
    const horizon = [
        dayKey(nowMs),
        dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()),
    ]
    const upcoming = list
        .filter(e => !e.allDay && e.endMs > nowMs && e.days.some(day => horizon.includes(day)))
        .sort((a, b) => a.startMs - b.startMs)
    setItems(
        upcoming
            .filter(e => !hidden.has(`gcal:${e.id}`))
            .map(e => attachActions(eventItemData(e, nowMs))),
    )
    scheduleReminders(upcoming)
}

// --------------------------------------------------------- lifecycle

let unsubscribe: (() => void) | null = null

export function dispose() {
    unsubscribe?.()
    unsubscribe = null
    for (const [, t] of reminderTimers) sourceRemove(t.src)
    reminderTimers.clear()
}

// -------------------------------------------------------------- startup

// registry presence must not depend on accounts: the provider registers
// at import (the center reads it whenever its lazy window is built),
// the state subscription arms in init() from app.tsx
if (Config.calendar.enabled) {
    registerProvider({
        name: "calendar",
        iconName: "x-office-calendar-symbolic",
        displayName: "Calendar",
        items,
        refresh,
        signIn: authenticate,
        signInVisible: accountEmails.as(list => list.length === 0),
        // events are future-dated: the center lists them next-first,
        // above the newest-first feed
        soonestFirst: true,
    } satisfies Provider)
}

export function init() {
    if (!Config.calendar.enabled || unsubscribe) return
    rebuild(visibleEvents.get()) // the cache may already be loaded
    unsubscribe = visibleEvents.subscribe(() => rebuild(visibleEvents.get()))
}

// tear-down entry point, run from app.tsx on shutdown (lib/lifecycle)
registerDispose("gcalReminders", dispose)
