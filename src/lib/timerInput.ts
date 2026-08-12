import GLib from "gi://GLib?version=2.0"

// What you can type into the sleep timer's entry.
//
// It has always taken a duration in minutes. A duration is the wrong
// unit for half of what the timer is used for, though: "wake me at 7:30"
// is a fact about the clock, and turning it into "in 512 minutes" is
// arithmetic the shell can do far better than a person half asleep.
//
// So the entry now takes either. A bare number is still minutes; a value
// with a colon in it is a clock time, and always resolves FORWARDS — a
// time that has already passed today means tomorrow, because nobody sets
// an alarm for the past.
//
// Kept free of the config and the clock so it can be tested: the caller
// injects `now`, exactly as todoist's snoozeDelayMs and taskData do.

/** how the entry reads and writes clock times */
export type TimeFormat = "24h" | "12h" | "auto"

/**
 * Whether this machine's locale writes times with AM/PM.
 *
 * There is no direct "is this locale 12-hour" call, so this asks the C
 * library to format a known afternoon time and looks for the hour it
 * chose: a 24-hour locale renders 13:00 with "13" in it, a 12-hour one
 * renders it as 1 o'clock plus a PM marker.
 */
export function localeUses12Hour(): boolean {
    const afternoon = GLib.DateTime.new_local(2000, 1, 1, 13, 0, 0)
    if (!afternoon) return false
    const formatted = afternoon.format("%X") ?? ""
    return !formatted.includes("13")
}

/** resolve "auto" against the locale; the other two mean what they say */
export function uses12Hour(format: TimeFormat): boolean {
    if (format === "24h") return false
    if (format === "12h") return true
    return localeUses12Hour()
}

const MINUTE_MS = 60_000

/** `7:30`, `07:30`, `7:30pm`, `7:30 PM`, `19:30` */
const CLOCK = /^(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?$/i

/**
 * Minutes from now until the moment the user asked for, or null when the
 * text is not something we can act on.
 *
 * @param text  whatever is in the entry
 * @param nowMs unix milliseconds for "now"
 * @param twelveHour whether a bare hour should be read as a 12-hour clock
 * @returns minutes (may be fractional — startSleepTimer multiplies by
 *          60_000, so seconds survive), or null
 */
export function parseTimerInput(text: string, nowMs: number, twelveHour: boolean): number | null {
    const trimmed = text.trim()
    if (trimmed === "") return null

    // no colon: the original behaviour, a duration in minutes
    if (!trimmed.includes(":")) {
        const minutes = Number(trimmed)
        return Number.isFinite(minutes) && minutes > 0 ? minutes : null
    }

    const m = CLOCK.exec(trimmed)
    if (!m) return null
    let hour = Number(m[1])
    const minute = Number(m[2])
    const suffix = m[3]?.toLowerCase().replace(/\./g, "")
    if (minute > 59) return null

    if (suffix) {
        // an explicit am/pm is a 12-hour clock whatever the setting says
        if (hour < 1 || hour > 12) return null
        if (suffix === "pm" && hour !== 12) hour += 12
        if (suffix === "am" && hour === 12) hour = 0
    } else if (hour > 23) {
        return null
    }

    const target = new Date(nowMs)
    target.setHours(hour, minute, 0, 0)
    let delta = target.getTime() - nowMs

    // A bare hour on a 12-hour clock is ambiguous: "7:30" is both 07:30
    // and 19:30. Take whichever comes first, which is the same "always
    // forwards" rule the rest of this follows — asking for 7:30 at 3pm
    // means this evening, not next morning.
    if (twelveHour && !suffix && hour < 12) {
        const pm = delta + 12 * 60 * MINUTE_MS
        if (delta <= 0 && pm > 0) delta = pm
    }

    // already gone today (or exactly now): they mean tomorrow. Advance
    // the calendar date, not by 24h of milliseconds — an ms offset
    // lands an hour off across a DST transition
    while (delta <= 0) {
        target.setDate(target.getDate() + 1)
        delta = target.getTime() - nowMs
    }

    return delta / MINUTE_MS
}

/** what to show in the empty entry, so the accepted syntax is visible
 *  rather than something you have to discover */
export function timerPlaceholder(twelveHour: boolean): string {
    return twelveHour ? "minutes, or 11:30 pm" : "minutes, or 23:30"
}
