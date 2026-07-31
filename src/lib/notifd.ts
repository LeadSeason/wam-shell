import AstalNotifd from "gi://AstalNotifd?version=0.1"
import Gio from "gi://Gio?version=2.0"
import GLib from "gi://GLib?version=2.0"
import { Accessor, createBinding, createState } from "gnim"
import { connect, disconnect, timeoutAdd, sourceRemove } from "./metrics"
import Config from "../config"
import type { ProviderItem } from "./notificationProviders"

// Shared notification daemon state. The first instantiation becomes
// the daemon (so swaync must not run alongside).

// Whose daemon handles notifications (notifications.daemon):
// "wam-shell" always ours, "system" never, "auto" ours only when no
// other daemon owns org.freedesktop.Notifications at startup. When the
// name is already taken astal backs off (it does not steal it), so the
// owner being someone else means a system daemon was there first.
// Must run before AstalNotifd.get_default(): once instantiated astal
// acquires the name itself, and the probe could read our own
// acquisition instead of a pre-existing owner's
function detectSystemDaemon(): boolean {
    try {
        const reply = Gio.DBus.session.call_sync(
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            "GetNameOwner",
            new GLib.Variant("(s)", ["org.freedesktop.Notifications"]),
            new GLib.VariantType("(s)"),
            Gio.DBusCallFlags.NONE,
            500,
            null,
        )
        const owner = reply.get_child_value(0).get_string()[0]
        return owner !== Gio.DBus.session.get_unique_name()
    } catch {
        return false // name has no owner
    }
}

const mode = Config.notifications.daemon
export const useOurs =
    mode === "wam-shell" ? true : mode === "system" ? false : !detectSystemDaemon()
if (!useOurs) console.log("Notifications: using the system daemon")

const notifd = AstalNotifd.get_default()

const notifications = createBinding(notifd, "notifications")
// notifications that belong in the center's history: everything except
// ones with the spec `transient` hint ("excluded from persistency" —
// attention-only events like a device connecting) and apps filtered out
// via notifications.transient_apps. Popups are unaffected by both.
export const persistent: Accessor<AstalNotifd.Notification[]> = notifications.as(list =>
    list.filter(
        n =>
            !n.transient &&
            !Config.notifications.transientApps.includes((n.appName || "unknown").toLowerCase()),
    ),
)
export const count = persistent.as(n => n.length)
export const dnd = createBinding(notifd, "dontDisturb")

export function toggleDnd() {
    notifd.dontDisturb = !notifd.dontDisturb
}

// --- transient popups -------------------------------------------------

// Popup banner state is the single source of truth for everything about
// a banner's lifetime: countdown, expiry, slide-in age. The per-monitor
// windows are pure views over it — they are rebuilt on every focus
// switch, so nothing of consequence may live in a row widget (a
// row-owned countdown used to reset on every monitor switch). Hiding a
// popup never dismisses the notification from the center.
const MAX_POPUPS = 4

// 200ms (5fps) is visually identical to 50ms for the timeout bar but
// a quarter of the wakeups
const TICK_MS = 200
// a banner animates in only while it is this young: rows rebuilt on a
// monitor switch must not replay the slide-in
export const POPUP_SLIDE_IN_MS = 400

// one banner slot: a desktop notification from our daemon, or a provider
// item (GitHub & co.). key is unique across both: "desktop:<id>" for
// daemon notifications, the provider's own "<provider>:<id>" otherwise
export interface PopupEntry {
    key: string
    desktop: AstalNotifd.Notification | null
    item: ProviderItem | null
}

export interface PopupTimer {
    // ms; 0 = never expires (critical)
    duration: number
    remaining: number
    // monotonic ms when the banner appeared
    addedAt: number
    expiring: boolean
}

const [popupsState, setPopups] = createState<PopupEntry[]>([])
export const popups: Accessor<PopupEntry[]> = popupsState

// popup key -> countdown state. Mutated in place by the manager tick;
// popupTimerVersion is the change signal rows subscribe to
const timers = new Map<string, PopupTimer>()
const [timerVersion, setTimerVersion] = createState(0)
export const popupTimerVersion: Accessor<number> = timerVersion
const bumpTimerVersion = () => setTimerVersion(timerVersion.get() + 1)

export function popupTimer(key: string): PopupTimer | null {
    return timers.get(key) ?? null
}

export function removePopup(key: string) {
    if (timers.delete(key)) bumpTimerVersion()
    setPopups(popupsState.get().filter(p => p.key !== key))
}

// hovering ANY banner freezes every countdown: if a banner above the
// hovered one expired mid-interaction, the stack would shift and yank
// the hovered banner out from under the pointer
let hoverCount = 0
export function setPopupHovered(hovered: boolean) {
    hoverCount = Math.max(0, hoverCount + (hovered ? 1 : -1))
}
export function anyPopupHovered(): boolean {
    return hoverCount > 0
}

// one manager tick for all banners (starts on the first, stops when the
// last is gone) — a tick per row would die on every monitor switch
let tickSource: number | null = null

function ensurePopupTick() {
    if (tickSource !== null) return
    let last = GLib.get_monotonic_time() / 1000 // us -> ms
    tickSource = timeoutAdd("notifd:popupTick", GLib.PRIORITY_DEFAULT, TICK_MS, () => {
        const now = GLib.get_monotonic_time() / 1000
        const dt = now - last
        last = now
        if (!anyPopupHovered() && dt > 0) {
            for (const [key, t] of timers) {
                if (t.duration === 0 || t.expiring) continue
                t.remaining -= dt
                if (t.remaining <= 0) {
                    t.expiring = true
                    // let the collapse animation play before dropping it
                    timeoutAdd("notifd:popupExpire", GLib.PRIORITY_DEFAULT, 220, () => {
                        removePopup(key)
                        return GLib.SOURCE_REMOVE
                    })
                }
            }
            bumpTimerVersion()
        }
        if (popupsState.get().length === 0) {
            tickSource = null
            return GLib.SOURCE_REMOVE
        }
        return GLib.SOURCE_CONTINUE
    })
}

// shared banner admission: DND gate, dedupe, countdown, cap. Returns
// false when the banner was not admitted
function addPopup(entry: PopupEntry, urgency: AstalNotifd.Urgency | null): boolean {
    // DND silences popups; critical notifications still break through
    if (notifd.dontDisturb && urgency !== AstalNotifd.Urgency.CRITICAL) return false
    const current = popupsState.get()
    if (current.some(p => p.key === entry.key)) return false
    // low urgency drains faster; critical never drains (duration 0)
    const total = Config.notifications.popupTimeout
    const duration =
        urgency === AstalNotifd.Urgency.CRITICAL
            ? 0
            : urgency === AstalNotifd.Urgency.LOW
              ? total / 2
              : total
    timers.set(entry.key, {
        duration,
        remaining: duration,
        addedAt: GLib.get_monotonic_time() / 1000,
        expiring: false,
    })
    setPopups([...current, entry].slice(-MAX_POPUPS))
    // prune entries of popups the MAX_POPUPS slice just dropped
    const live = new Set(popupsState.get().map(p => p.key))
    for (const key of timers.keys()) if (!live.has(key)) timers.delete(key)
    bumpTimerVersion()
    ensurePopupTick()
    return true
}

// a brand-new provider thread (github poll diff) wants a banner. The
// banner expiring is NOT a dismissal: the item stays in the center
export function addProviderPopup(item: ProviderItem) {
    if (!useOurs) return // no popup windows exist in that case
    addPopup({ key: item.id, desktop: null, item }, null)
}

const notifiedId = connect(notifd, "notified", (_s: AstalNotifd.Notifd, id: number) => {
    if (!useOurs) return
    const n = notifd.get_notification(id)
    if (!n) return
    addPopup({ key: `desktop:${id}`, desktop: n, item: null }, n.urgency)
})

// dismissed/expired elsewhere (center, app) -> drop the banner too
const resolvedId = connect(notifd, "resolved", (_s: AstalNotifd.Notifd, id: number) =>
    removePopup(`desktop:${id}`),
)

export function dispose() {
    if (tickSource !== null) {
        sourceRemove(tickSource)
        tickSource = null
    }
    disconnect(notifd, notifiedId)
    disconnect(notifd, resolvedId)
}

export default notifd
