import Gio from "gi://Gio?version=2.0"

// The parts every notification-center provider needs and none of them
// should own: arrival diffing, the banner horizon, "open this in the
// browser", and the age gate behind `refresh()`.
//
// These were four byte-identical copies (github, todoist, protonmail,
// youtube). That is not just repetition — the banner horizon is a
// safety rule (an inbox healing after an outage must not replay two
// days of history at the screen), and a rule with four implementations
// is a rule that holds in three places and quietly lapses in the
// fourth. Provider-SPECIFIC logic deliberately stays in the provider:
// GitHub's conditional requests, Todoist's reminders, ProtonMail's IDLE
// loop and YouTube's quota backoff are what those modules are for.

/**
 * ids in `next` that `prev` did not carry.
 *
 * Brand-new items only: new activity on an item that keeps its id (a
 * comment on an already-unread thread, an edited task) stays quiet.
 */
export function newArrivals(prev: { id: string }[], next: { id: string }[]): string[] {
    const prevIds = new Set(prev.map(i => i.id))
    return next.filter(i => !prevIds.has(i.id)).map(i => i.id)
}

/**
 * How old an item may be and still earn a banner.
 *
 * Two days, because the failure this guards against is a provider
 * coming BACK: a token that starts working again, a bridge that
 * restarts, a first sweep on a fresh machine. Every one of those
 * delivers a pile of items the shell has never seen, and without a
 * horizon each one is a banner.
 */
export const BANNER_HORIZON_SEC = 48 * 3600

/**
 * Items worth raising a banner for: not already known, and recent
 * enough that a healing inbox cannot replay history.
 *
 * @param next the items the poll just produced
 * @param seen every id that must NOT banner — the persisted seen store,
 *        the previously displayed list, or both unioned
 * @param nowSec unix seconds, passed in so the helper stays pure
 */
export function bannerCandidates<T extends { id: string; time: number }>(
    next: T[],
    seen: Set<string>,
    nowSec: number,
    horizonSec = BANNER_HORIZON_SEC,
): T[] {
    return next.filter(i => !seen.has(i.id) && i.time >= nowSec - horizonSec)
}

/**
 * Open an item's url in the user's browser.
 *
 * Async and best-effort: a missing default handler is a warning, not a
 * failure that should stop the "mark read" half of an activation.
 */
export function openUrl(url: string, logTag: string): void {
    Gio.AppInfo.launch_default_for_uri_async(url, null, null, (_s, res) => {
        try {
            Gio.AppInfo.launch_default_for_uri_finish(res)
        } catch (e) {
            console.warn(`${logTag}: could not open the browser:`, e)
        }
    })
}

/**
 * The age gate behind every provider's `refresh()`.
 *
 * The notification center revalidates on open, and a user toggling it
 * would otherwise spend a request per toggle — on an API with a rate
 * limit (GitHub, Todoist), a daily quota (YouTube) or a local daemon
 * that should not be hammered (the ProtonMail bridge).
 *
 * @param minAgeMs how stale the last attempt must be before another runs
 * @returns a function that runs `poll` at most that often. The provider
 *          keeps recording `lastAttempt` itself through `touch()`, so a
 *          scheduled poll also resets the gate
 */
export function createRefreshGate(minAgeMs: number, poll: () => void) {
    let lastAttempt = 0
    return {
        refresh() {
            if (Date.now() - lastAttempt < minAgeMs) return
            lastAttempt = Date.now()
            poll()
        },
        /** a poll started elsewhere (the timer, a mutation) counts too */
        touch() {
            lastAttempt = Date.now()
        },
    }
}
