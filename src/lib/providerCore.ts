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
    let backoffUntil = 0
    return {
        refresh() {
            if (Date.now() < backoffUntil) return
            if (Date.now() - lastAttempt < minAgeMs) return
            lastAttempt = Date.now()
            poll()
        },
        /** a poll started elsewhere (the timer, a mutation) counts too */
        touch() {
            lastAttempt = Date.now()
        },
        /** true while a 429/503 backoff is in force — the scheduled poll
         *  checks this too, so the timer does not walk straight past it */
        blocked() {
            return Date.now() < backoffUntil
        },
        /** how much longer, in whole seconds (0 when not blocked) */
        blockedFor() {
            return Math.max(0, Math.ceil((backoffUntil - Date.now()) / 1000))
        },
        /** hold every poll off for this long */
        backOff(seconds: number) {
            backoffUntil = Math.max(backoffUntil, Date.now() + seconds * 1000)
        },
        clearBackoff() {
            backoffUntil = 0
        },
    }
}

/**
 * How long to wait after a rate-limited or overloaded reply.
 *
 * Every provider here polls on a fixed interval and treats a failure as
 * "try again next time", which is right for a transient 500 and wrong
 * for a 429: the server has said, in a header, exactly how long to stop
 * for, and re-asking on schedule is what turns a short limit into a long
 * one. Nothing in the tree read that header.
 *
 * Three sources, in order:
 *  - `Retry-After` as a delay in seconds (the common form)
 *  - `Retry-After` as an HTTP date (the spec allows it; GitHub uses it
 *    for secondary limits)
 *  - a doubling fallback keyed on how many times in a row we have been
 *    told to back off, for the servers that say 429 and nothing else
 *
 * Clamped at both ends: never less than a second (a 0 would busy-loop),
 * never more than an hour (a server asking for a day is not something to
 * honour silently on a desktop, and the next shell restart clears it).
 *
 * @param header the raw Retry-After value, "" when absent
 * @param consecutive how many backoffs in a row, 1 for the first
 * @param nowMs injected so the date branch is testable
 */
export function retryAfterSeconds(header: string, consecutive: number, nowMs = Date.now()): number {
    const MIN = 1
    const MAX = 3600
    const clamp = (n: number) => Math.min(MAX, Math.max(MIN, Math.round(n)))

    const raw = header.trim()
    if (raw) {
        // a bare integer is a delay in seconds
        if (/^\d+$/.test(raw)) return clamp(Number(raw))
        // otherwise an HTTP date; past dates mean "now", not a negative wait
        const at = Date.parse(raw)
        if (!Number.isNaN(at)) return clamp((at - nowMs) / 1000)
    }
    // no usable header: 30s, 60s, 120s, … capped
    return clamp(30 * 2 ** Math.max(0, consecutive - 1))
}

/** statuses that mean "stop asking for a while", not "this request
 *  failed". 429 is the rate limit; 503 is an overloaded or maintenance
 *  server, which re-asking on schedule does not help either */
export function isBackoffStatus(status: number): boolean {
    return status === 429 || status === 503
}

/**
 * A wait, for the empty state to show a human.
 *
 * "retrying in 40m" answers the question a rate-limited provider raises
 * ("is it broken, or is it waiting?"), which "Couldn't sync" does not.
 * Coarse on purpose: it is read once, and a countdown to the second
 * would need a ticking clock for a number nobody is watching.
 */
export function formatWait(seconds: number): string {
    if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`
    const hours = seconds / 3600
    return `${hours < 10 ? hours.toFixed(1).replace(/\.0$/, "") : Math.round(hours)}h`
}
