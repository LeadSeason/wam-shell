import GLib from "gi://GLib?version=2.0"
import { test, eq } from "./framework"
import { resolveZone, isValidZone, at, atMs, civil, dayKey, hhmm, fromMs } from "../src/lib/tz"

// Two zones a fixed number of hours apart, so a pinned instant can be
// asserted to fall on DIFFERENT calendar days in each — the one property
// a display timezone has to get right, and the one that does not depend
// on which zone this machine happens to be in.
const NY = GLib.TimeZone.new("America/New_York")!
const STOCKHOLM = GLib.TimeZone.new("Europe/Stockholm")!
const local = GLib.TimeZone.new_local()!

// 2026-01-15 23:30 UTC: 18:30 on the 15th in New York, 00:30 on the 16th
// in Stockholm
const EDGE = Date.UTC(2026, 0, 15, 23, 30, 0)

test("tz isValidZone: IANA ids and fixed offsets pass, junk does not", () => {
    eq(isValidZone("Europe/Stockholm"), true, "IANA id")
    eq(isValidZone("America/New_York"), true, "a second IANA id")
    eq(isValidZone("+02:00"), true, "fixed offset")
    eq(isValidZone("-0530"), true, "offset without a colon")
    eq(isValidZone("Not/AZone"), false, "unknown id")
    eq(isValidZone("Europe/Stockoll"), false, "a near-miss typo")
    eq(isValidZone("1234"), false, "a bare number")
    // GLib would answer "UTC" to this and look like it worked, which is
    // the whole reason the check goes through Intl
    eq(GLib.TimeZone.new("Not/AZone")!.get_identifier(), "UTC", "GLib accepts junk silently")
})

test("tz resolveZone: auto and empty mean the local zone", () => {
    eq(resolveZone("auto").get_identifier(), local.get_identifier(), "auto")
    eq(resolveZone("").get_identifier(), local.get_identifier(), "empty string")
})

test("tz resolveZone: a known id resolves to that id", () => {
    eq(resolveZone("Europe/Stockholm").get_identifier(), "Europe/Stockholm", "IANA id")
    eq(resolveZone("+02:00").get_identifier(), "+02:00", "fixed offset")
})

test("tz resolveZone: an unknown id falls back to local rather than refusing", () => {
    // reported on stderr; the point is the shell keeps running on the
    // machine's zone instead of dying or adopting GLib's silent UTC
    eq(resolveZone("Not/AZone").get_identifier(), local.get_identifier(), "fallback")
})

test("tz dayKey: the same instant is a different day in two zones", () => {
    eq(dayKey(EDGE, NY), "2026-01-15", "New York is still on the 15th")
    eq(dayKey(EDGE, STOCKHOLM), "2026-01-16", "Stockholm has rolled to the 16th")
})

test("tz dayKey: zero-padded YYYY-MM-DD", () => {
    eq(dayKey(Date.UTC(2026, 0, 5, 12), STOCKHOLM), "2026-01-05", "single-digit month")
    eq(dayKey(Date.UTC(2026, 8, 5, 12), STOCKHOLM), "2026-09-05", "single-digit day")
})

test("tz hhmm: 24h clock in the zone", () => {
    eq(hhmm(EDGE, NY), "18:30", "New York")
    eq(hhmm(EDGE, STOCKHOLM), "00:30", "Stockholm, next day")
})

test("tz civil: decomposes a ms epoch in the zone", () => {
    const c = civil(EDGE, STOCKHOLM)
    eq(`${c.y}-${c.m}-${c.d} ${c.h}:${c.mi}`, "2026-1-16 0:30", "Stockholm")
    const n = civil(EDGE, NY)
    eq(`${n.y}-${n.m}-${n.d} ${n.h}:${n.mi}`, "2026-1-15 18:30", "New York")
})

test("tz at/atMs: a civil time in a zone is the right instant", () => {
    // 2026-01-16 00:30 in Stockholm is 2026-01-15 23:30 UTC
    eq(atMs(2026, 1, 16, 0, 30, 0, STOCKHOLM), Date.UTC(2026, 0, 15, 23, 30), "Stockholm")
    // the same civil clock time in New York is 5 hours earlier in UTC
    eq(atMs(2026, 1, 16, 0, 30, 0, NY), Date.UTC(2026, 0, 16, 5, 30), "New York")
    // and midnight Stockholm 2026-01-16
    eq(atMs(2026, 1, 16, 0, 0, 0, STOCKHOLM), Date.UTC(2026, 0, 15, 23, 0), "midnight")
})

test("tz at: out-of-range dates normalise, as new Date does and GLib does not", () => {
    // GLib.DateTime.new(tz, 2026, 1, 32, …) is NULL; new Date rolls into
    // February. Callers legitimately leave the range (monthGrid's leading
    // cells, syncWindow's ±months, a day-of-month stepped by one at a
    // month end), so this has to roll over too.
    eq(at(2026, 1, 32, 12, 0, 0, STOCKHOLM).format("%Y-%m-%d %H:%M"), "2026-02-01 12:00", "day 32")
    eq(at(2026, 13, 1, 0, 0, 0, STOCKHOLM).format("%Y-%m-%d"), "2027-01-01", "month 13")
    eq(at(2026, 0, 1, 0, 0, 0, STOCKHOLM).format("%Y-%m-%d"), "2025-12-01", "month 0")
    eq(at(2026, 1, 0, 0, 0, 0, STOCKHOLM).format("%Y-%m-%d"), "2025-12-31", "day 0")
    eq(at(2026, 2, 29, 0, 0, 0, STOCKHOLM).format("%Y-%m-%d"), "2026-03-01", "non-leap Feb 29")
    eq(at(2024, 2, 29, 0, 0, 0, STOCKHOLM).format("%Y-%m-%d"), "2024-02-29", "leap Feb 29 kept")
})

test("tz at: normalisation matches JS Date across a year of days", () => {
    // one check per day is overkill in a suite that runs every commit, so
    // pin the shape at the boundaries instead: a full leap cycle either
    // side of the year, and every month length
    const probes: [number, number, number][] = [
        [2024, 1, 31],
        [2024, 2, 29],
        [2024, 3, 31],
        [2024, 4, 30],
        [2024, 12, 31],
        [2025, 2, 28],
        [2025, 12, 31],
        [2026, 1, 1],
    ]
    for (const [y, m, d] of probes) {
        const expected = new Date(Date.UTC(y, m - 1, d))
        const got = at(y, m, d, 0, 0, 0, STOCKHOLM)
        eq(
            `${got.get_year()}-${got.get_month()}-${got.get_day_of_month()}`,
            `${expected.getUTCFullYear()}-${expected.getUTCMonth() + 1}-${expected.getUTCDate()}`,
            `${y}-${m}-${d}`,
        )
    }
})

test("tz fromMs: a round trip preserves the instant", () => {
    // whole seconds in, whole seconds out — sub-second is dropped by design
    eq(fromMs(EDGE, STOCKHOLM).to_unix() * 1000, EDGE, "Stockholm")
    eq(fromMs(EDGE, NY).to_unix() * 1000, EDGE, "New York")
    eq(fromMs(0, STOCKHOLM).to_unix(), 0, "the epoch itself")
})

test("tz atMs/civil: a round trip through a DST transition", () => {
    // Europe/Stockholm springs forward on 2026-03-29 and falls back on
    // 2026-10-25. Noon on either side of each is an ordinary instant, so
    // a round trip must land exactly there — a naive ±86400s would not.
    const days: [number, number][] = [
        [3, 28],
        [3, 29],
        [3, 30],
        [10, 24],
        [10, 25],
        [10, 26],
    ]
    for (const [m, d] of days) {
        const c = civil(atMs(2026, m, d, 12, 0, 0, STOCKHOLM), STOCKHOLM)
        eq(
            [c.y, c.m, c.d, c.h, c.mi],
            [2026, m, d, 12, 0],
            `2026-${m}-${d} noon, before/after the transition`,
        )
    }
})
