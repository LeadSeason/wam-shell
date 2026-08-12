import AstalNotifd from "gi://AstalNotifd?version=0.1"
import Gio from "gi://Gio?version=2.0"
import GLib from "gi://GLib?version=2.0"
import { Accessor, createBinding, createState } from "gnim"
import { connect, disconnect, idleAdd, timeoutAdd, sourceRemove } from "./metrics"
import Config from "../config"
import { providers } from "./notificationProviders"
import type { ProviderItem } from "./notificationProviders"
import {
    MAX_POPUPS,
    capPopups,
    displayGroups,
    groupPopups,
    popupAppName,
    popupDuration,
    staleArrivalKeys,
} from "./popupStack"
import type { PopupEntry, PopupGroup, PopupTimer } from "./popupStack"
// The stack's RULES live in lib/popupStack, which has no import-time
// side effects so the unit suite can pin them without this module's
// D-Bus probe and AstalNotifd.get_default() coming along. Re-exported
// here because this is still the address every caller knows.
export { capPopups, displayGroups, groupPopups, popupDuration, staleArrivalKeys }
export type { PopupEntry, PopupGroup, PopupTimer }
import { registerDispose } from "./lifecycle"
import { writeFileAtomic } from "./atomicWrite"

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

// --- per-app mute -----------------------------------------------------
//
// Muting the LOCAL_SOURCE above silences every desktop notification at
// once, which is a blunt instrument: the reason to reach for it is
// almost always one chatty application, and silencing the other twenty
// to get at it means missing the ones that mattered.
//
// Persisted, unlike the provider mutes, and the difference is not an
// inconsistency. A provider mute is a "not right now" you make while
// looking at the centre's filter chips. "This app never needs to
// interrupt me" is a decision about that app, and one you would have to
// make again after every update, logout and crash if it lived in
// memory. `[notifications] transient_apps` is the config-file sibling —
// that one says "keep it out of the history", this one says "do not
// let it interrupt", and they are independent on purpose.
const mutedAppsPath = `${Config.instanceCacheDir}/muted-apps.json`

function loadMutedApps(): string[] {
    try {
        if (!GLib.file_test(mutedAppsPath, GLib.FileTest.EXISTS)) return []
        const [ok, bytes] = GLib.file_get_contents(mutedAppsPath)
        if (!ok) return []
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
        // hand-edited or truncated: a bad file must not take the daemon
        // down, and an empty list is the safe reading of "unknown"
        if (!Array.isArray(parsed)) return []
        return parsed.filter((v): v is string => typeof v === "string")
    } catch (e) {
        console.warn("notifd: could not read the muted-app list:", e)
        return []
    }
}

const [mutedApps, setMutedApps] = createState<string[]>(loadMutedApps())
export { mutedApps }

/** compared lowercased everywhere: app names arrive however the sender spelled them */
export function isAppMuted(appName: string): boolean {
    return mutedApps.get().includes((appName || "unknown").toLowerCase())
}

export function toggleAppMute(appName: string) {
    const key = (appName || "unknown").toLowerCase()
    const cur = mutedApps.get()
    const next = cur.includes(key) ? cur.filter(n => n !== key) : [...cur, key]
    setMutedApps(next)
    writeFileAtomic(mutedAppsPath, JSON.stringify(next)).catch(e =>
        console.warn("notifd: could not persist the muted-app list:", e),
    )
}

// --- transient popups -------------------------------------------------

// Popup banner state is the single source of truth for everything about
// a banner's lifetime: countdown, expiry, slide-in age. The per-monitor
// windows are pure views over it — they are rebuilt on every focus
// switch, so nothing of consequence may live in a row widget (a
// row-owned countdown used to reset on every monitor switch). Hiding a
// popup never dismisses the notification from the center.
//
// The stack's pure rules (the cap, the folding, the durations) live in
// lib/popupStack; what is left here is the state and the sources that
// drive them.

// 200ms (5fps) is visually identical to 50ms for the timeout bar but
// a quarter of the wakeups
const TICK_MS = 200
// a banner animates in only while it is this young: rows rebuilt on a
// monitor switch must not replay the slide-in
export const POPUP_SLIDE_IN_MS = 400

/**
 * The banner stack, **oldest first** — admission appends.
 *
 * That order is load-bearing in two directions and the two disagree,
 * which is exactly why it is written down here: `capPopups` evicts from
 * the FRONT (the oldest ordinary banner), while `groupPopups` wants
 * NEWEST first (the newest arrival is the card's representative, and
 * criticals lead). The conversion between them belongs to this module —
 * see `displayGroups`, which is what views must render.
 */
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

// Collapse animations in flight: key -> GLib source. A banner whose
// countdown hit zero is dropped 220ms later so the collapse can play,
// and until then the source is the only thing holding that removal.
// Untracked, it outlived dispose() and fired removePopup against a torn
// down module — and a banner dismissed by hand inside its own collapse
// window left a source that removed an already-gone key.
const expiring = new Map<string, number>()

function cancelExpire(key: string) {
    const src = expiring.get(key)
    if (src === undefined) return
    expiring.delete(key)
    sourceRemove(src)
}

// Removals asked for from inside a gesture handler: key -> GLib source.
//
// Destroying the widget GTK is currently delivering an event to is the
// shape behind GNOME/gtk#3090: crossing-event synthesis holds the old
// hover target across the dispatch, and recycling that widget mid-flight
// leaves the pointer stale — `gtk_synthesize_crossing_events` then walks
// freed memory. Both of the 2026-08-06 segfaults landed there.
//
// A banner is exactly that shape. removePopup runs synchronously through
// the popups state and the <For> above it, so clicking a banner to
// dismiss it destroys the very widget the click is being delivered to,
// while the pointer is still inside it. One idle turn puts the teardown
// after GTK has finished with the event.
//
// This is a dodge, not a fix — the bug is upstream and open, and it was
// never reproduced here (a 210-round hover/expiry/dismiss soak came back
// clean), so treat it as removing a known hazard rather than as a closed
// case. It costs one idle turn of latency on a banner that is about to
// animate away regardless.
//
// Tracked like `expiring` above, and for the same reason it had to be:
// an untracked source outlives dispose() and fires against a torn-down
// module.
const deferredRemoval = new Map<string, number>()

function cancelDeferred(key: string) {
    const src = deferredRemoval.get(key)
    if (src === undefined) return
    deferredRemoval.delete(key)
    sourceRemove(src)
}

/**
 * `removePopup`, for callers inside a gesture or click handler.
 *
 * Idempotent and coalescing: a second click on the same banner before
 * the idle runs is a no-op, and any other path removing the key first
 * cancels the pending source.
 *
 * A re-add landing inside the pending window cannot resurrect the wrong
 * banner, which is the race this looks like it has: while the removal is
 * queued the entry is still in `popupsState`, so `addPopup` rejects the
 * key outright (or, for a `desktop:` replacement, swaps the notification
 * — which the pending idle then removes anyway), and once the idle has
 * run the map entry is already gone. The two states never overlap.
 */
export function removePopupDeferred(key: string) {
    if (deferredRemoval.has(key)) return
    const src = idleAdd("notifd:removePopupDeferred", GLib.PRIORITY_DEFAULT_IDLE, () => {
        // dropped before removePopup so its cancelDeferred cannot try to
        // sourceRemove the source it is running inside
        deferredRemoval.delete(key)
        removePopup(key)
        return GLib.SOURCE_REMOVE
    })
    deferredRemoval.set(key, src)
}

export function removePopup(key: string) {
    cancelExpire(key)
    cancelDeferred(key)
    if (timers.delete(key)) bumpTimerVersion()
    setPopups(popupsState.get().filter(p => p.key !== key))
    forgetFinishedApps()
}

// --- snooze -----------------------------------------------------------
//
// "Not now, but do come back." The gap between dismissing a banner (it
// is gone, and the only trace is a row in the centre you have to
// remember to open) and letting it drain (it is gone in four seconds
// either way). Snoozing takes the banner off screen and puts the same
// one back later, countdown and all.
//
// Keyed by popup key, holding everything `addPopup` will need to admit
// it a second time — the notification object itself stays alive in the
// daemon's list, so this is a re-admission, not a copy.
interface Snoozed {
    entry: Omit<PopupEntry, "critical">
    urgency: AstalNotifd.Urgency | null
    expireMs: number
    source: number
}

const snoozed = new Map<string, Snoozed>()

/** how long a snooze lasts, in ms. One value, no menu: a snooze that
 *  asks you to pick a duration is slower than reading the notification. */
export const SNOOZE_MS = 10 * 60 * 1000

/**
 * Bring a snoozed banner back — through the same doors it came in by.
 *
 * A snooze is ten minutes of the user doing something else, which is
 * ample time for the thing to stop being worth interrupting for, and for
 * the user to decide they never want to hear from it again. Both of
 * those have to be re-checked at the moment of re-admission, not at the
 * moment of snoozing:
 *
 *  - **Still outstanding?** A desktop notification may have been
 *    dismissed from the centre; a provider item may have been completed
 *    (the Todoist task got done) or hidden. Re-raising a banner for
 *    something already dealt with is worse than forgetting it — and a
 *    due reminder is CRITICAL, so it comes back with no timeout at all
 *    and has to be dismissed by hand.
 *  - **Still allowed to interrupt?** `addPopup` is only the DND gate.
 *    The per-source mute lives in `addProviderPopup` and the per-app
 *    mute in the `notified` handler, so calling `addPopup` directly
 *    walked straight past a mute applied while the banner was snoozed.
 *
 * The provider item is looked up fresh rather than replayed: a poll in
 * the meantime may have replaced the object (a moved due time, an edited
 * title), and the stale copy's actions close over the old state.
 */
function unsnooze(held: Snoozed) {
    const { desktop, item } = held.entry
    if (desktop) {
        if (!notifd.get_notification(desktop.id)) return
        // the two gates the `notified` handler applies
        if (mutedProviders.get().includes(LOCAL_SOURCE)) return
        if (isAppMuted(desktop.appName)) return
        addPopup(held.entry, held.urgency, held.expireMs)
        return
    }
    if (!item) return
    const fresh = providers
        .find(p => p.name === item.provider)
        ?.items.get()
        .find(i => i.id === item.id)
    // completed, hidden, or aged out of the provider's list
    if (!fresh) return
    // applies the muted-provider gate, and re-derives the duration the
    // same way the first admission did
    addProviderPopup(fresh, held.urgency)
}

/**
 * Take a banner off screen and bring it back in ten minutes.
 *
 * Returns false when the key is not on screen, which is the case a
 * double click produces: the first one already removed it.
 */
export function snoozePopup(key: string): boolean {
    const entry = popupsState.get().find(p => p.key === key)
    if (!entry || snoozed.has(key)) return false

    const timer = timers.get(key)
    // what the sender originally asked for, so the second showing drains
    // like the first rather than inheriting the default
    const expireMs = timer && timer.duration > 0 ? timer.duration : timer ? 0 : -1
    const urgency = entry.critical ? AstalNotifd.Urgency.CRITICAL : null

    const source = timeoutAdd("notifd:snooze", GLib.PRIORITY_DEFAULT, SNOOZE_MS, () => {
        const held = snoozed.get(key)
        snoozed.delete(key)
        if (!held) return GLib.SOURCE_REMOVE
        unsnooze(held)
        return GLib.SOURCE_REMOVE
    })

    snoozed.set(key, {
        entry: { key: entry.key, desktop: entry.desktop, item: entry.item },
        urgency,
        expireMs,
        source,
    })
    // deferred: this is reached from a click on the banner itself
    removePopupDeferred(key)
    return true
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

/** a countdown that can still move (criticals never drain) */
const draining = () => [...timers.values()].some(t => t.duration !== 0 && !t.expiring)
/** a banner inside its 220ms collapse window */
const collapsing = () => [...timers.values()].some(t => t.expiring)

function ensurePopupTick() {
    if (tickSource !== null) return
    let last = GLib.get_monotonic_time() / 1000 // us -> ms
    tickSource = timeoutAdd("notifd:popupTick", GLib.PRIORITY_DEFAULT, TICK_MS, () => {
        const now = GLib.get_monotonic_time() / 1000
        const dt = now - last
        last = now
        if (!anyPopupHovered() && dt > 0) {
            let moved = false
            for (const [key, t] of timers) {
                if (t.duration === 0 || t.expiring) continue
                moved = true
                t.remaining -= dt
                if (t.remaining <= 0) {
                    t.expiring = true
                    // let the collapse animation play before dropping it.
                    // Tracked so dispose() can cancel it and so a manual
                    // dismiss inside the window doesn't leave it armed
                    const src = timeoutAdd("notifd:popupExpire", GLib.PRIORITY_DEFAULT, 220, () => {
                        expiring.delete(key)
                        removePopup(key)
                        return GLib.SOURCE_REMOVE
                    })
                    expiring.set(key, src)
                }
            }
            // A bump is what PopupRow watches, for two different things:
            // to redraw a countdown that moved, and to collapse a banner
            // whose `expiring` is set. The collapse cue is why this is
            // not just `moved` — a row rebuilt inside the 220ms window
            // (monitor hotplug, group re-fold) gets no further movement
            // to ride on and would vanish instead of collapsing.
            //
            // But it is not unconditional either: a critical banner has
            // duration 0 and never drains, and bumping anyway kept every
            // subscriber recomputing five times a second for as long as
            // one sat un-dismissed.
            if (moved || collapsing()) bumpTimerVersion()
        }
        // Stop once nothing left can move. Gating only the BUMP still
        // left this 200ms source waking the main loop forever behind a
        // critical, which is most of what the tick actually costs.
        // Computed outside the hover branch on purpose: hovering freezes
        // countdowns, it must not decide whether the tick lives.
        // ensurePopupTick runs on every admission, so a later drainable
        // banner simply starts it again.
        if (popupsState.get().length === 0 || !(draining() || collapsing())) {
            tickSource = null
            return GLib.SOURCE_REMOVE
        }
        return GLib.SOURCE_CONTINUE
    })
}

// How many banners an app has actually raised during the current burst,
// which is NOT the same as how many are on screen.
//
// The group badge used to count live entries, so it silently capped at
// MAX_POPUPS: ten arrivals from one app read "4", and the number meant
// "how many we kept" rather than "how many happened" — the one thing a
// count on a folded card exists to say.
//
// The tally is per app and lives only as long as that app has a banner
// up: once its last one leaves the screen the burst is over, and the
// next arrival starts again at one rather than resuming a stale total.
const arrivals = new Map<string, number>()

function forgetFinishedApps() {
    const live = popupsState
        .get()
        .filter(p => !p.critical)
        .map(popupAppName)
    for (const app of staleArrivalKeys([...arrivals.keys()], live)) arrivals.delete(app)
}

/** the number the folded card shows. Criticals never fold, so they
 *  always stand for exactly themselves */
export function popupArrivals(p: PopupEntry): number {
    if (p.critical) return 1
    return arrivals.get(popupAppName(p)) ?? 1
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
    const existing = current.find(p => p.key === entry.key)
    if (existing) {
        // a desktop notification with a replaces_id arrives under the
        // SAME key: it is an update to a banner already on screen, not
        // a new one. Swap the notification the entry shows and restart
        // its countdown — rejecting it left the old summary/body/actions
        // up until the original banner expired
        if (!existing.desktop || !entry.desktop) return false
        // a replacement landing inside the collapse window revives the
        // banner, so the pending removal must not fire
        cancelExpire(entry.key)
        const duration = popupDuration(expireMs, urgency, Config.notifications.popupTimeout)
        timers.set(entry.key, {
            duration,
            remaining: duration,
            // keeps its age: an update must not replay the slide-in
            addedAt: timers.get(entry.key)?.addedAt ?? GLib.get_monotonic_time() / 1000,
            expiring: false,
        })
        setPopups(current.map(p => (p.key === entry.key ? { ...entry, critical } : p)))
        bumpTimerVersion()
        // a swap can put a DRAINING countdown where a non-draining
        // banner (critical, expire_timeout=0) sat — the tick stopped
        // behind it, and without this the replacement never counts down
        ensurePopupTick()
        return true
    }
    const duration = popupDuration(expireMs, urgency, Config.notifications.popupTimeout)
    timers.set(entry.key, {
        duration,
        remaining: duration,
        addedAt: GLib.get_monotonic_time() / 1000,
        expiring: false,
    })
    const admitted: PopupEntry = { ...entry, critical }
    if (!critical) {
        const app = popupAppName(admitted)
        arrivals.set(app, (arrivals.get(app) ?? 0) + 1)
    }
    setPopups(capPopups([...current, admitted], MAX_POPUPS))
    // prune entries of popups the cap just dropped
    const live = new Set(popupsState.get().map(p => p.key))
    for (const key of timers.keys()) if (!live.has(key)) timers.delete(key)
    forgetFinishedApps()
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

let notifiedId = connect(notifd, "notified", (_s: AstalNotifd.Notifd, id: number) => {
    if (!useOurs) return
    const n = notifd.get_notification(id)
    if (!n) return
    // muting the local source is a per-source DND: the notification
    // still lands in the center, it just does not interrupt. Absolute,
    // like a muted provider — a mute nobody can rely on is not a mute
    if (mutedProviders.get().includes(LOCAL_SOURCE)) return
    // and the same, for one app rather than all of them. Absolute too,
    // criticals included: unlike DND, which is a mood, this is a
    // standing instruction about a specific sender — an app that is
    // muted precisely because it shouts should not be able to shout
    // louder to get through
    if (isAppMuted(n.appName)) return
    // the sender's own expire_timeout leads; -1 means it deferred to us
    addPopup({ key: `desktop:${id}`, desktop: n, item: null }, n.urgency, n.expireTimeout ?? -1)
})

// dismissed/expired elsewhere (center, app) -> drop the banner too.
//
// Deferred, because this is the funnel the banner's own buttons come
// back through: onDismiss calls desktop.dismiss() and onAction calls
// desktop.invoke(), and astal emits "resolved" synchronously inside
// both — so a click on a banner reaches removePopup through HERE, still
// inside GTK's dispatch to that banner, whatever the caller in
// PopupRow does. Deferring only the call in PopupRow would have looked
// like a fix and changed nothing.
let resolvedId = connect(notifd, "resolved", (_s: AstalNotifd.Notifd, id: number) =>
    removePopupDeferred(`desktop:${id}`),
)

export function dispose() {
    if (tickSource !== null) {
        sourceRemove(tickSource)
        tickSource = null
    }
    // collapse animations still in flight, and removals deferred out of
    // a gesture handler, would otherwise fire removePopup on a module
    // that is already down
    for (const src of expiring.values()) sourceRemove(src)
    expiring.clear()
    for (const src of deferredRemoval.values()) sourceRemove(src)
    deferredRemoval.clear()
    // a snooze outliving the module would re-admit a banner into a
    // popup stack nothing is ticking any more
    for (const held of snoozed.values()) sourceRemove(held.source)
    snoozed.clear()
    // zeroed as they go, like every other handle above: runDisposers()
    // can be reached twice (a shutdown signal after an explicit quit),
    // and disconnecting a dead handler id is a GLib-CRITICAL
    if (notifiedId) {
        disconnect(notifd, notifiedId)
        notifiedId = 0
    }
    if (resolvedId) {
        disconnect(notifd, resolvedId)
        resolvedId = 0
    }
}

export default notifd

// tear-down entry point, run from app.tsx on shutdown (lib/lifecycle)
registerDispose("notifd", dispose)
