import GLib from "gi://GLib?version=2.0"
import Config from "../config"

export type Zone = GLib.TimeZone

export interface Civil {
    y: number
    m: number // 1-12, GLib's numbering
    d: number
    h: number
    mi: number
    s: number
}

/** the local zone — what "auto" resolves to, and the fallback for anything else */
function local(): Zone {
    return GLib.TimeZone.new_local()!
}

// ---------------------------------------------------- civil calendar math
//
// GLib's DateTime constructor returns NULL for an out-of-range day or
// month — `GLib.DateTime.new(tz, 2026, 1, 32, …)` is null, where
// `new Date(2026, 0, 32)` quietly rolls into February. That matters
// because several callers legitimately leave the range: monthGrid's
// leading cells sit in the previous month, syncWindow asks for a month
// five away, dayLabel steps a day-of-month by one at a month end.
//
// So a date is normalised here first, in plain proleptic-Gregorian
// integer arithmetic (Howard Hinnant's days_from_civil /
// civil_from_days), and only then handed to GLib with values it accepts.
// No Date, no zone, no I/O — which is also what makes it worth pinning
// in tests against a hundred years of days.

/** days since 1970-01-01 for a proleptic-Gregorian date (month 1-based) */
function daysFromCivil(y: number, m: number, d: number): number {
    const y2 = y - (m <= 2 ? 1 : 0)
    const era = Math.floor(y2 / 400)
    const yoe = y2 - era * 400 // [0, 399]
    const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1 // [0, 365]
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy // [0, 146096]
    return era * 146097 + doe - 719468
}

/** the inverse of daysFromCivil */
function civilFromDays(z0: number): { y: number; m: number; d: number } {
    const z = z0 + 719468
    const era = Math.floor(z / 146097)
    const doe = z - era * 146097 // [0, 146096]
    const yoe = Math.floor(
        (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
    )
    const y = yoe + era * 400
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)) // [0, 365]
    const mp = Math.floor((5 * doy + 2) / 153) // [0, 11]
    const d = doy - Math.floor((153 * mp + 2) / 5) + 1 // [1, 31]
    const m = mp + (mp < 10 ? 3 : -9) // [1, 12]
    return { y: y + (m <= 2 ? 1 : 0), m, d }
}

/**
 * Is `id` a zone this machine actually knows?
 *
 * Asked through Intl rather than GLib because GLib does not answer it:
 * `GLib.TimeZone.new("Not/AZone")` returns a perfectly ordinary
 * GTimeZone for UTC instead of failing, so the only way to notice a typo
 * is to ask a library that will say so. Intl is available in GJS's
 * SpiderMonkey and throws on an unknown identifier — which is why it is
 * used here, once, and nowhere else in the repo.
 *
 * Fixed offsets ("+02:00") pass too; Intl accepts them as time zones.
 */
export function isValidZone(id: string): boolean {
    try {
        new Intl.DateTimeFormat("en", { timeZone: id })
        return true
    } catch {
        return false
    }
}

/**
 * Resolve one configured id to a GTimeZone.
 *
 * "auto" and an empty string mean the system's own zone. Anything else
 * must be an IANA identifier or a fixed offset; an unrecognised one is
 * reported and falls back to local rather than being refused — the same
 * contract every reader in lib/configSchema has, and the same reason:
 * a config typo must never take the shell down, and must never silently
 * apply something the user did not write.
 */
export function resolveZone(id: string): Zone {
    if (id === "auto" || id === "") return local()
    if (!isValidZone(id)) {
        console.error(
            `Config "timezone" is not a known time zone: ${JSON.stringify(id)} — ` +
                `expected "auto" or an identifier like "Europe/Stockholm" or "+02:00". ` +
                `Falling back to the local zone.`,
        )
        return local()
    }
    return GLib.TimeZone.new(id) ?? local()
}

let cached: Zone | null = null

/**
 * The configured zone, resolved once.
 *
 * Cached rather than re-read: the config is loaded once at startup and
 * the zone cannot change under a running shell, exactly as
 * `uses12Hour()` argues for the locale. Lazily resolved on first use so
 * importing this module costs nothing and cannot race Config's own
 * import-time statics.
 */
export function zone(): Zone {
    if (cached === null) cached = resolveZone(Config.timezone)
    return cached
}

/** "now" in the zone — replaces `GLib.DateTime.new_now_local()` */
export function now(): GLib.DateTime {
    return GLib.DateTime.new_now(zone())!
}

/**
 * A ms epoch as a DateTime in the zone.
 *
 * Built through UTC and converted, not through a zoned
 * `new_from_unix(tz, sec)`: GJS's GLib does not expose that constructor
 * — only the `_local` and `_utc` forms — so `to_timezone` is the only
 * route that does not assume the machine's own zone.
 *
 * MILLISECONDS, like every other function here: `Date.now()`,
 * `.getTime()`, and every `startMs`/`endMs`/`deadline` in this codebase
 * are ms, so the one place a unix-seconds stamp meets this module (an
 * AstalNotifd timestamp, a Harvest API field) multiplies by 1000 at the
 * call site where a reader can see it.
 */
export function fromMs(ms: number, z: Zone = zone()): GLib.DateTime {
    return GLib.DateTime.new_from_unix_utc(Math.floor(ms / 1000))!.to_timezone(z)!
}

/**
 * A civil date/time in the zone — the zone-aware replacement for
 * `GLib.DateTime.new_local(...)`.
 *
 * Months are 1-based (GLib's numbering, unlike `new Date`). The date is
 * normalised first, so `at(2026, 1, 32)` is 1 February and `at(2026,
 * 13, 1)` is 1 January 2027 — the answers `new Date` gives, and the
 * ones GLib's own constructor refuses to give.
 *
 * On a spring-forward date the requested civil time may not exist
 * (Europe/Stockholm 2026-03-29 has no 02:00–03:00); GLib resolves such
 * an instant to the offset in effect, the same answer JS gives. Harmless
 * for the day keys and midnights this is used for, and the one place the
 * zone arithmetic is knowingly not exact.
 */
export function at(
    y: number,
    m: number,
    d: number,
    h = 0,
    mi = 0,
    s = 0,
    z: Zone = zone(),
): GLib.DateTime {
    const n = civilFromDays(daysFromCivil(y, m, d))
    return GLib.DateTime.new(z, n.y, n.m, n.d, h, mi, s)!
}

/**
 * The ms epoch of a civil date/time in the zone — the zone-aware
 * replacement for `new Date(y, m, d).getTime()`.
 */
export function atMs(
    y: number,
    m: number,
    d: number,
    h = 0,
    mi = 0,
    s = 0,
    z: Zone = zone(),
): number {
    return at(y, m, d, h, mi, s, z).to_unix() * 1000
}

/**
 * A ms epoch decomposed into the zone's civil date and time — the
 * zone-aware replacement for `new Date(ms).getFullYear()` and friends.
 *
 * Whole seconds only: every caller renders a clock time or a calendar
 * day, and the sub-second part is dropped rather than carried around.
 */
export function civil(ms: number, z: Zone = zone()): Civil {
    const dt = fromMs(ms, z)
    return {
        y: dt.get_year(),
        m: dt.get_month(),
        d: dt.get_day_of_month(),
        h: dt.get_hour(),
        mi: dt.get_minute(),
        s: dt.get_second(),
    }
}

/** "YYYY-MM-DD" in the zone — the one key every day boundary shares */
export function dayKey(ms: number = Date.now(), z: Zone = zone()): string {
    return fromMs(ms, z).format("%Y-%m-%d")!
}

/** "HH:MM", 24h, in the zone */
export function hhmm(ms: number, z: Zone = zone()): string {
    return fromMs(ms, z).format("%H:%M")!
}
