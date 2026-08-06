import GLib from "gi://GLib?version=2.0"
import { Accessor, createState } from "gnim"
import { timeoutAddSeconds, sourceRemove } from "./metrics"

// How long ago something happened, for notification rows.
//
// The center used to print wall-clock times (21:58, 17:06, 16:39), which
// is the one thing you never want to know about a notification: you care
// that it arrived four hours ago, not that it arrived at 17:06, and
// working that out is arithmetic the row can do for you.
//
// Deliberately coarse. A notification list is scanned, not read, so the
// value has to be legible at a glance and stable enough not to flicker
// between two renderings of the same row — minutes for the first hour,
// hours for the first day, then days, then a date. Nothing says "1 hour
// ago" in five words when "1h" fits the same slot.

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * A compact age for a unix timestamp.
 *
 * @param time  unix seconds (AstalNotifd.Notification.time and
 *              ProviderItem.time are both in these units)
 * @param nowSec  unix seconds for "now" — injected so the formatting is
 *              pure and can be pinned in tests
 * @returns "now", "5m", "3h", "2d", or "6 Aug" past a week
 */
export function relTime(time: number, nowSec: number): string {
    const age = nowSec - time
    // clock skew, or a provider timestamping slightly ahead of us: an
    // item from "the future" is newly arrived as far as the reader is
    // concerned, and "-1m" would just look broken
    if (age < MINUTE) return "now"
    if (age < HOUR) return `${Math.floor(age / MINUTE)}m`
    if (age < DAY) return `${Math.floor(age / HOUR)}h`
    if (age < 7 * DAY) return `${Math.floor(age / DAY)}d`
    const dt = GLib.DateTime.new_from_unix_local(time)
    return dt ? `${dt.get_day_of_month()} ${MONTHS[dt.get_month() - 1].slice(0, 3)}` : ""
}

// Day and month names, in English, spelled out here rather than taken
// from GLib's %A/%B.
//
// Those follow the user's LOCALE, and every other string this shell
// draws is English — so a list read "Today / Yesterday / tisdag /
// måndag", switching language halfway down as soon as it got past the
// two labels that had no strftime equivalent and were therefore
// hardcoded. Picking one language is the only way that list is
// coherent, and English is the one the rest of the UI already speaks.
//
// If the shell ever grows real localisation, these belong in it
// alongside "Needs you", "Feed" and the rest — not reverted to %A,
// which would only restore the half-translated version.
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
const MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
]

/**
 * The day-bucket a timestamp belongs to, for dividers in a list that
 * spans more than one day.
 *
 * Calendar days, not 24-hour windows: something from 23:50 last night is
 * "Yesterday" at 00:10 even though it is twenty minutes old, because
 * that is how people talk about it.
 */
export function dayBucket(time: number, nowSec: number): string {
    const then = GLib.DateTime.new_from_unix_local(time)
    const now = GLib.DateTime.new_from_unix_local(nowSec)
    if (!then || !now) return ""
    const days = dayNumber(now) - dayNumber(then)
    if (days <= 0) return "Today"
    if (days === 1) return "Yesterday"
    // GLib numbers weekdays 1 (Monday) through 7 (Sunday)
    if (days < 7) return WEEKDAYS[then.get_day_of_week() - 1]
    return `${then.get_day_of_month()} ${MONTHS[then.get_month() - 1]}`
}

// days since the epoch in LOCAL time — subtracting two of these compares
// calendar days without any timezone arithmetic of our own
function dayNumber(dt: GLib.DateTime): number {
    return Math.floor((dt.to_unix() + dt.get_utc_offset() / 1_000_000) / DAY)
}

// ------------------------------------------------------- the live clock

// A relative time that never updates is worse than an absolute one: a
// row stuck on "now" an hour later is actively lying, where "17:06" was
// merely unhelpful. So the center drives its rows off this shared clock
// while it is open.
//
// Refcounted, and the timer only exists while someone holds it: a shell
// that spends all day with the center closed must not wake up twice a
// minute to recompute strings nobody is looking at. Banners deliberately
// do NOT hold it — one lives a few seconds, so its "now" is still true
// when it disappears.
const [now, setNow] = createState(Math.floor(GLib.get_real_time() / 1_000_000))
export const nowSec: Accessor<number> = now

// half the smallest unit relTime prints, so a row is never more than
// ~30s stale and "now" -> "1m" lands close to when it actually happened
const TICK_SEC = 30

let holders = 0
let source: number | null = null

/** Start (or join) the shared clock. Call the returned function to
 *  release it; the timer stops when the last holder lets go. */
export function acquireClock(): () => void {
    holders++
    if (source === null) {
        // the value is stale by up to a full tick when the clock has
        // been stopped for a while — refresh before anyone renders
        setNow(Math.floor(GLib.get_real_time() / 1_000_000))
        source = timeoutAddSeconds("relTime:clock", GLib.PRIORITY_DEFAULT, TICK_SEC, () => {
            setNow(Math.floor(GLib.get_real_time() / 1_000_000))
            return GLib.SOURCE_CONTINUE
        })
    }
    let released = false
    return () => {
        // a double release would drop the count below zero and strand
        // the timer running forever
        if (released) return
        released = true
        holders--
        if (holders <= 0 && source !== null) {
            sourceRemove(source)
            source = null
            holders = 0
        }
    }
}
