import { test, eq } from "./framework"
import { parseTimerInput, timerPlaceholder, uses12Hour } from "../src/lib/timerInput"

// fixed "now": 2026-08-07 14:30 local
const NOW = new Date(2026, 7, 7, 14, 30, 0).getTime()
const MIN = 60_000
const at = (h: number, m: number, dayOffset = 0) =>
    (new Date(2026, 7, 7 + dayOffset, h, m, 0).getTime() - NOW) / MIN

test("timerInput: a bare number is still minutes", () => {
    eq(parseTimerInput("30", NOW, false), 30)
    eq(parseTimerInput("  45  ", NOW, false), 45)
    eq(parseTimerInput("0.5", NOW, false), 0.5)
})

test("timerInput: a non-positive or unparseable duration is rejected", () => {
    eq(parseTimerInput("0", NOW, false), null)
    eq(parseTimerInput("-5", NOW, false), null)
    eq(parseTimerInput("soon", NOW, false), null)
    eq(parseTimerInput("", NOW, false), null)
    eq(parseTimerInput("   ", NOW, false), null)
})

test("timerInput: a clock time later today is the gap until then", () => {
    eq(parseTimerInput("23:30", NOW, false), at(23, 30))
    eq(parseTimerInput("14:31", NOW, false), 1)
    // a leading zero is the same time
    eq(parseTimerInput("09:00", NOW, false), parseTimerInput("9:00", NOW, false))
})

test("timerInput: a time already past today lands tomorrow", () => {
    // 07:00 is this morning; nobody sets an alarm for the past
    eq(parseTimerInput("07:00", NOW, false), at(7, 0, 1))
})

test("timerInput: exactly now rolls a whole day rather than firing instantly", () => {
    eq(parseTimerInput("14:30", NOW, false), 24 * 60)
})

test("timerInput: seconds of the current minute are not lost", () => {
    // 40s into 14:30, asking for 14:31 is 20 seconds away, not a minute
    const withSeconds = new Date(2026, 7, 7, 14, 30, 40).getTime()
    eq(parseTimerInput("14:31", withSeconds, false), 20 / 60)
})

test("timerInput: an explicit am/pm is honoured whatever the setting", () => {
    eq(parseTimerInput("11:30 pm", NOW, false), at(23, 30))
    eq(parseTimerInput("11:30pm", NOW, true), at(23, 30))
    eq(parseTimerInput("11:30 PM", NOW, false), at(23, 30))
    eq(parseTimerInput("11:30 p.m.", NOW, false), at(23, 30))
    // morning, so tomorrow
    eq(parseTimerInput("7:00 am", NOW, false), at(7, 0, 1))
})

test("timerInput: midnight and noon in 12-hour form", () => {
    eq(parseTimerInput("12:00 am", NOW, false), at(0, 0, 1)) // 00:00 tomorrow
    eq(parseTimerInput("12:30 pm", NOW, false), at(12, 30, 1)) // 12:30 already past
})

test("timerInput: a bare hour on a 12-hour clock takes whichever comes first", () => {
    // 7:30 at 14:30 means this evening, not next morning
    eq(parseTimerInput("7:30", NOW, true), at(19, 30))
    // but 11:00, whose morning has passed and whose evening has not,
    // still resolves forwards to 23:00
    eq(parseTimerInput("11:00", NOW, true), at(23, 0))
})

test("timerInput: a 24-hour reading never guesses at pm", () => {
    eq(parseTimerInput("7:30", NOW, false), at(7, 30, 1))
})

test("timerInput: impossible clock values are rejected", () => {
    eq(parseTimerInput("25:00", NOW, false), null)
    eq(parseTimerInput("12:60", NOW, false), null)
    eq(parseTimerInput("13:00 pm", NOW, false), null) // 13 is not a 12-hour hour
    eq(parseTimerInput("0:00 am", NOW, false), null)
    eq(parseTimerInput("7:5", NOW, false), null) // minutes must be two digits
    eq(parseTimerInput(":30", NOW, false), null)
    eq(parseTimerInput("7:30:00", NOW, false), null)
})

test("timerInput: uses12Hour resolves the explicit settings without the locale", () => {
    eq(uses12Hour("24h"), false)
    eq(uses12Hour("12h"), true)
    // "auto" follows the machine and is deliberately not asserted here
})

test("timerInput: the placeholder shows the accepted syntax", () => {
    eq(timerPlaceholder(false).includes("23:30"), true)
    eq(timerPlaceholder(true).includes("11:30"), true)
})
