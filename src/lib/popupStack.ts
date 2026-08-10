import AstalNotifd from "gi://AstalNotifd?version=0.1"
import type { ProviderItem } from "./notificationProviders"

// The banner stack's rules, with none of the machinery that runs them.
//
// Split out of lib/notifd for the same reason widgets/notifications/
// feed.ts is split out of the centre: these are the parts worth pinning
// in tests, and the module they lived in cannot be imported by a test at
// all. notifd calls `AstalNotifd.get_default()` and a synchronous D-Bus
// name probe at import — so `pnpm test` pulling it in made the test
// binary acquire org.freedesktop.Notifications on the developer's live
// session whenever the shell was not already running, quietly swallowing
// their desktop notifications for the length of the run. AGENTS.md names
// notifd in the list of modules tests must not import; this is what that
// rule needs in order to be followable.
//
// Everything here is pure: no state, no sources, no get_default(). The
// gi import is the type namespace and the Urgency enum, which is inert.

/** the most banners on screen at once, before the cap starts evicting */
export const MAX_POPUPS = 4

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

/**
 * Enforce the banner cap, evicting the oldest ORDINARY banner first.
 *
 * A plain `slice(-MAX)` drops whatever is oldest, which is usually
 * right and is exactly wrong when the oldest is the one that matters: a
 * burst of four "sync complete"s would silently delete the critical
 * banner underneath them. A critical is only evicted when the whole
 * stack is critical and something has to give.
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
    /**
     * Identity for the view's `For`, covering every MEMBER — not just
     * the representative.
     *
     * gnim reuses the existing child for an unchanged key and never
     * re-invokes the factory, and `PopupRow` reads its group once at
     * construction. Keyed on the newest entry alone, a card whose OLDER
     * members expired or were dismissed kept rendering them in its hover
     * drawer, with countdowns for timers the controller had already
     * forgotten. For a single banner this is just its own key.
     */
    key: string
    entries: PopupEntry[]
}

/** the membership-covering key described on PopupGroup.key */
function groupKey(entries: PopupEntry[]): string {
    return entries.map(e => e.key).join("|")
}

/** the app a banner belongs to, lowercased; "" when it names none */
export function popupAppName(p: PopupEntry): string {
    return (p.desktop?.appName || p.item?.appName || "").toLowerCase()
}

/** apps we are still counting for that have no banner left on screen */
export function staleArrivalKeys(tracked: string[], live: string[]): string[] {
    const alive = new Set(live)
    return tracked.filter(app => !alive.has(app))
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
 * @param list newest first — NOT the order `popups` is stored in.
 *        Views want `displayGroups` instead, which owns the conversion
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
    // keys last, once each group's membership is final: a card's identity
    // has to cover the banners it stands for, not just the one it shows
    for (const g of ordinary) g.key = groupKey(g.entries)
    return [...urgent, ...ordinary]
}

/**
 * What a banner window renders: the stored stack, folded into cards, in
 * the order they should appear on screen.
 *
 * The one place the stored order (oldest first, see `popups`) is turned
 * into the display order (newest first). Every per-monitor window used
 * to do the `.reverse()` itself, which put a convention lib/notifd owns
 * in the hands of its views — and left nothing that pins the whole
 * pipeline, since the pure halves are only ever tested in isolation.
 */
export function displayGroups(list: PopupEntry[]): PopupGroup[] {
    return groupPopups([...list].reverse())
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
