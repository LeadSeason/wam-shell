import GLib from "gi://GLib?version=2.0"
import { test, eq } from "./framework"
import { relTime, dayBucket } from "../src/lib/relTime"

// a fixed "now" so nothing here depends on when the suite runs
const NOW = GLib.DateTime.new_local(2026, 8, 6, 14, 30, 0)!.to_unix()
const MIN = 60
const HOUR = 60 * MIN
const DAY = 24 * HOUR

test("relTime: under a minute reads as now", () => {
    eq(relTime(NOW, NOW), "now")
    eq(relTime(NOW - 59, NOW), "now")
})

test("relTime: minutes below the hour", () => {
    eq(relTime(NOW - MIN, NOW), "1m")
    eq(relTime(NOW - 59 * MIN, NOW), "59m")
})

test("relTime: hours below the day", () => {
    eq(relTime(NOW - HOUR, NOW), "1h")
    eq(relTime(NOW - 23 * HOUR, NOW), "23h")
})

test("relTime: days below the week", () => {
    eq(relTime(NOW - DAY, NOW), "1d")
    eq(relTime(NOW - 6 * DAY, NOW), "6d")
})

test("relTime: past a week falls back to a date", () => {
    // English, deliberately, and asserted as such: %b would follow the
    // machine's locale and print "27 jul" on a Swedish one, in a list
    // whose other labels ("Today", "Yesterday") can only be English
    eq(relTime(NOW - 10 * DAY, NOW), "27 Jul")
})

test("relTime: a future timestamp reads as now, not a negative age", () => {
    // clock skew, or a provider stamping slightly ahead of us
    eq(relTime(NOW + 5 * MIN, NOW), "now")
})

test("dayBucket: same calendar day", () => {
    eq(dayBucket(NOW, NOW), "Today")
    eq(dayBucket(NOW - 14 * HOUR, NOW), "Today") // 00:30 the same morning
})

test("dayBucket: yesterday is a calendar day, not 24 hours", () => {
    // 23:50 the previous evening is ~15h old but still "Yesterday"
    const lastNight = GLib.DateTime.new_local(2026, 8, 5, 23, 50, 0)!.to_unix()
    eq(dayBucket(lastNight, NOW), "Yesterday")
})

test("dayBucket: earlier in the week names the day, in English", () => {
    // 2026-08-03 is a Monday. Asserting the English name is the point:
    // %A returns "mandag"/"lundi"/... depending on the machine, which is
    // how the list ended up switching language halfway down
    const monday = GLib.DateTime.new_local(2026, 8, 3, 9, 0, 0)!
    eq(dayBucket(monday.to_unix(), NOW), "Monday")
})

test("dayBucket: past a week falls back to a date, in English", () => {
    const old = GLib.DateTime.new_local(2026, 7, 20, 9, 0, 0)!
    eq(dayBucket(old.to_unix(), NOW), "20 July")
})
