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

// Sources muted from the notification center: their notifications still
// collect there, but never raise transient banners (the per-source
// equivalent of DND). Session-only, toggled from the center's header.
const [mutedProviders, setMutedProviders] = createState<string[]>([])
export { mutedProviders }

/**
 * The key the local daemon is muted under, alongside the providers.
 *
 * The desktop's own notifications are a source like any other, and were
 * the only one you could not silence on its own — GitHub could be muted
 * while a chatty app could not, leaving DND (which silences everything)
 * as the only option. Reusing the provider set rather than adding a
 * second flag keeps one mute mechanism, and keeps the center's filter
 * chips and the mute list speaking the same vocabulary.
 */
export const LOCAL_SOURCE = "local"

export function toggleProviderMute(name: string) {
    const cur = mutedProviders.get()
    setMutedProviders(cur.includes(name) ? cur.filter(n => n !== name) : [...cur, name])
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
    // urgent enough that the stack must never bury it. Recorded at
    // admission rather than read back off the notification, because a
    // provider item carries no urgency of its own — the caller decides
    // (todoist's due reminders raise CRITICAL for exactly this reason)
    critical: boolean
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

/**
 * Enforce the banner cap, evicting the oldest ORDINARY banner first.
 *
 * A plain `slice(-MAX)` drops whatever is oldest, which is usually
 * right and is exactly wrong when the oldest is the one that matters: a
 * burst of four "sync complete"s would silently delete the critical
 * banner underneath them. A critical is only evicted when the whole
 * stack is critical and something has to give.
 *
 * Pure so the precedence can be pinned in tests.
 */
export function capPopups(list: PopupEntry[], max: number): PopupEntry[] {
    if (list.length <= max) return list
    const out = [...list]
    while (out.length > max) {
        const i = out.findIndex(p => !p.critical)
        // no ordinary banner left to sacrifice: fall back to the oldest
        out.splice(i >= 0 ? i : 0, 1)
    }
    return out
}

/** one card's worth of banner: usually a single notification, more when
 *  several from one app were folded together. entries[0] is the newest
 *  and is what the card shows */
export interface PopupGroup {
    key: string
    entries: PopupEntry[]
}

function popupAppName(p: PopupEntry): string {
    return (p.desktop?.appName || p.item?.appName || "").toLowerCase()
}

/**
 * Fold banners from the same app into one card.
 *
 * The problem is a chatty app, not a busy desktop: five "sync complete"s
 * are five cards saying one thing, and they push everything else off the
 * screen. One card that says the app's name and how many is the same
 * information in a fifth of the space.
 *
 * Criticals never merge. Folding one into a group would hide the
 * headline that mattered behind whichever notification happened to
 * arrive last, and they carry no timeout, so it would hide indefinitely.
 * They also lead, ahead of everything ordinary.
 *
 * @param list newest first
 */
export function groupPopups(list: PopupEntry[]): PopupGroup[] {
    const urgent: PopupGroup[] = []
    const ordinary: PopupGroup[] = []
    const byApp = new Map<string, PopupGroup>()
    for (const p of list) {
        if (p.critical) {
            urgent.push({ key: p.key, entries: [p] })
            continue
        }
        // an app with no name at all cannot be grouped by one: folding
        // every anonymous notification together would merge unrelated
        // senders into a single misleading count
        const app = popupAppName(p)
        const open = app === "" ? undefined : byApp.get(app)
        if (open) {
            open.entries.push(p)
            continue
        }
        const group: PopupGroup = { key: p.key, entries: [p] }
        if (app !== "") byApp.set(app, group)
        ordinary.push(group)
    }
    return [...urgent, ...ordinary]
}

/**
 * How long a banner stays up, in ms. 0 means it never expires.
 *
 * The sender gets the first say. The freedesktop spec gives every
 * notification an `expire_timeout`: -1 asks the server to decide, 0
 * means "leave it up", and anything positive is a request in
 * milliseconds. The shell used to ignore the field completely and apply
 * its own configured length to everything, so an app asking for a
 * twenty-second banner got five, and an app asking for a permanent one
 * got five as well.
 *
 * Only when the sender defers (-1, or a provider item, which has no such
 * field) does the configured default apply — and that default is where
 * urgency comes in: low drains twice as fast, critical does not drain.
 *
 * Pure so the precedence can be pinned in tests.
 *
 * @param expireMs the sender's request, -1 for "you decide"
 * @param total the configured default length
 */
export function popupDuration(
    expireMs: number,
    urgency: AstalNotifd.Urgency | null,
    total: number,
): number {
    if (expireMs === 0) return 0
    if (expireMs > 0) return expireMs
    if (urgency === AstalNotifd.Urgency.CRITICAL) return 0
    return urgency === AstalNotifd.Urgency.LOW ? total / 2 : total
}

// shared banner admission: DND gate, dedupe, countdown, cap. Returns
// false when the banner was not admitted
function addPopup(
    entry: Omit<PopupEntry, "critical">,
    urgency: AstalNotifd.Urgency | null,
    expireMs: number = -1,
): boolean {
    const critical = urgency === AstalNotifd.Urgency.CRITICAL
    // DND silences popups; critical notifications still break through
    if (notifd.dontDisturb && !critical) return false
    const current = popupsState.get()
    if (current.some(p => p.key === entry.key)) return false
    const duration = popupDuration(expireMs, urgency, Config.notifications.popupTimeout)
    timers.set(entry.key, {
        duration,
        remaining: duration,
        addedAt: GLib.get_monotonic_time() / 1000,
        expiring: false,
    })
    setPopups(capPopups([...current, { ...entry, critical }], MAX_POPUPS))
    // prune entries of popups the cap just dropped
    const live = new Set(popupsState.get().map(p => p.key))
    for (const key of timers.keys()) if (!live.has(key)) timers.delete(key)
    bumpTimerVersion()
    ensurePopupTick()
    return true
}

// a brand-new provider thread (github poll diff) or a due reminder
// wants a banner. The banner expiring is NOT a dismissal: the item
// stays in the center. urgency CRITICAL banners never drain and break
// through DND (todoist due reminders use this).
export function addProviderPopup(item: ProviderItem, urgency: AstalNotifd.Urgency | null = null) {
    if (!useOurs) return // no popup windows exist in that case
    if (mutedProviders.get().includes(item.provider)) return
    addPopup({ key: item.id, desktop: null, item }, urgency)
}

const notifiedId = connect(notifd, "notified", (_s: AstalNotifd.Notifd, id: number) => {
    if (!useOurs) return
    const n = notifd.get_notification(id)
    if (!n) return
    // muting the local source is a per-source DND: the notification
    // still lands in the center, it just does not interrupt. Absolute,
    // like a muted provider — a mute nobody can rely on is not a mute
    if (mutedProviders.get().includes(LOCAL_SOURCE)) return
    // the sender's own expire_timeout leads; -1 means it deferred to us
    addPopup({ key: `desktop:${id}`, desktop: n, item: null }, n.urgency, n.expireTimeout ?? -1)
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
