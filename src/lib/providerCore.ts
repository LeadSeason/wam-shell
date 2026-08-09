import Gio from "gi://Gio?version=2.0"
import GLib from "gi://GLib?version=2.0"
import { timeoutAddSeconds, sourceRemove } from "./metrics"

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
    // consecutive 429/503s, for the doubling fallback when the server
    // sends no Retry-After. It lives HERE rather than as a `let backoffs`
    // beside each provider's poll: the counter and the deadline it feeds
    // are one piece of state, and keeping them apart is what let gcal
    // reset one without the other. Reset by the first clean poll
    let consecutive = 0
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
        /**
         * The whole 429/503 response, in one call.
         *
         * Every provider had a byte-identical copy of this — bump the
         * counter, read Retry-After, install the wait, set a status
         * string, warn — differing only in its log tag. That is a rule
         * with three implementations, which is a rule that holds in two
         * places, and the drift was already visible: gcal grew its own
         * counter/deadline pair and could reset one without the other.
         *
         * @param reply the failing reply; only status and Retry-After
         *        are read. `header` is optional because not every client
         *        exposes response headers (googleRequest does not), in
         *        which case the doubling fallback is all there is
         * @param logTag the provider's name, for the warning and the
         *        user-facing status line
         * @param setStatus where the "retrying in 40m" line goes.
         *        Optional: gcal feeds the clock popover, which has no
         *        status line of its own
         * @returns true when this WAS a backoff status and the caller
         *          should stop and keep its stale items
         */
        noteBackoff(
            reply: { status: number; header?: (name: string) => string },
            logTag: string,
            setStatus?: (s: string) => void,
        ): boolean {
            if (!isBackoffStatus(reply.status)) return false
            consecutive++
            const wait = retryAfterSeconds(reply.header?.("Retry-After") ?? "", consecutive)
            backoffUntil = Math.max(backoffUntil, Date.now() + wait * 1000)
            setStatus?.(`${logTag} is rate limiting — retrying in ${formatWait(wait)}`)
            console.warn(`${logTag}: ${reply.status}; backing off ${wait}s`)
            return true
        },
        /** a clean poll: drop the hold-off AND the escalation it feeds */
        clearBackoff() {
            backoffUntil = 0
            consecutive = 0
        },
    }
}

/**
 * The "not now" every provider offers on a right-click: take the row out
 * of the centre for this session, without telling the service anything.
 *
 * Four providers had their own `Set` of hidden ids and their own
 * identical closure around it, and they had already drifted — todoist's
 * also cancels the task's armed reminders and pulls its banner, github's
 * does neither, so "hide" quietly meant two different things depending
 * on which row you right-clicked. The `extra` hook is where a provider
 * says what else hiding implies for it, in one visible place.
 *
 * Session-scoped on purpose: it is a "not now", and the next shell start
 * is a new session.
 *
 * @param items the provider's own item state
 * @param setItems its setter
 * @param extra provider-specific consequences of hiding (cancel timers,
 *        drop a live banner)
 */
export function createSessionHide<T extends { id: string }>(
    items: { get(): T[] },
    setItems: (next: T[]) => void,
    extra?: (id: string) => void,
) {
    const hidden = new Set<string>()
    return {
        /** filtered out of every poll, so it does not reappear */
        has: (id: string) => hidden.has(id),
        hide(id: string) {
            hidden.add(id)
            extra?.(id)
            setItems(items.get().filter(i => i.id !== id))
        },
    }
}

/**
 * A provider's fixed-interval poll: prime it, keep it running, stop it.
 *
 * The `let pollTimer = 0` / arm-in-init / clear-in-dispose triple was
 * written out longhand in every provider that polls on a fixed cadence,
 * which is three places to get the `sourceRemove`-then-zero dance
 * slightly wrong. Providers whose cadence is NOT fixed keep their own
 * loops and should: youtube recomputes its interval from the quota and
 * its failure streak on every tick, and protonmail's poll is a fallback
 * that hands back to IDLE. Those are different behaviours, not copies.
 *
 * @param label the metrics label for the source
 * @param minutes the interval
 * @param poll run immediately on start, then every interval
 */
export function createPollLoop(label: string, minutes: number, poll: () => void) {
    let timer = 0
    return {
        start() {
            if (timer) return
            poll()
            timer = timeoutAddSeconds(label, GLib.PRIORITY_DEFAULT, minutes * 60, () => {
                poll()
                return GLib.SOURCE_CONTINUE
            })
        },
        /** idempotent, and safe when the loop never started */
        stop() {
            if (!timer) return
            sourceRemove(timer)
            timer = 0
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
