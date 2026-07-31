import { test, eq } from "./framework"
import { dayKey, eventDays, mapGoogleEvent, timeLabel } from "../src/lib/gcal"

// local ms for readability: d(31, 10) = the 31st of this month at 10:00
const d = (day: number, h = 0, min = 0) => new Date(2026, 6, day, h, min).getTime() // July = 6

test("gcal dayKey: local YYYY-MM-DD with zero padding", () => {
    eq(dayKey(new Date(2026, 0, 5, 23, 59).getTime()), "2026-01-05")
    eq(dayKey(d(31, 10)), "2026-07-31")
})

test("gcal eventDays: same-day timed event covers one day", () => {
    eq(eventDays(d(31, 10), d(31, 11), false), ["2026-07-31"])
})

test("gcal eventDays: multi-day timed event covers every day touched", () => {
    eq(eventDays(d(30, 22), d(1, 1, 1) + 31 * 86_400_000, false).length > 0, true)
    eq(eventDays(d(30, 22), d(31) + 86_400_000 + 3_600_000, false), [
        "2026-07-30",
        "2026-07-31",
        "2026-08-01",
    ])
})

test("gcal eventDays: timed event ending at midnight does not spill", () => {
    // 23:00 -> 00:00 next day: only the start day
    eq(eventDays(d(31, 23), d(31) + 86_400_000, false), ["2026-07-31"])
})

test("gcal eventDays: all-day end is exclusive (Google convention)", () => {
    const start = d(31)
    const endExclusive = d(31) + 86_400_000 // next midnight
    eq(eventDays(start, endExclusive, true), ["2026-07-31"])
    // two-day all-day event
    eq(eventDays(start, endExclusive + 86_400_000, true), ["2026-07-31", "2026-08-01"])
})

test("gcal eventDays: zero-length event covers its start day", () => {
    eq(eventDays(d(31, 10), d(31, 10), false), ["2026-07-31"])
})

test("gcal mapGoogleEvent: cancelled events are dropped", () => {
    eq(mapGoogleEvent("c", "Cal", "#fff", { status: "cancelled" }), null)
})

test("gcal mapGoogleEvent: timed event with local dateTime", () => {
    const e = mapGoogleEvent("c1", "Work", "#a1b2c3", {
        id: "ev1",
        summary: "Standup",
        start: { dateTime: "2026-07-31T10:00:00" },
        end: { dateTime: "2026-07-31T10:30:00" },
    })
    eq(e?.allDay, false)
    eq(e?.days, ["2026-07-31"])
    eq(e?.calendarName, "Work")
    eq(e?.color, "#a1b2c3")
    eq(e?.id, "c1:ev1")
})

test("gcal mapGoogleEvent: missing summary falls back", () => {
    const e = mapGoogleEvent("c", "Cal", "#fff", {
        id: "x",
        start: { dateTime: "2026-07-31T10:00:00" },
        end: { dateTime: "2026-07-31T11:00:00" },
    })
    eq(e?.summary, "(no title)")
})

test("gcal mapGoogleEvent: all-day event uses exclusive end date", () => {
    const e = mapGoogleEvent("c", "Cal", "#fff", {
        id: "ad",
        summary: "Holiday",
        start: { date: "2026-07-31" },
        end: { date: "2026-08-02" },
    })
    eq(e?.allDay, true)
    eq(e?.days, ["2026-07-31", "2026-08-01"])
})

test("gcal mapGoogleEvent: unparseable times are dropped", () => {
    eq(
        mapGoogleEvent("c", "Cal", "#fff", {
            id: "bad",
            start: {},
            end: {},
        }),
        null,
    )
})

test("gcal timeLabel: all day vs timed range", () => {
    const allDay = mapGoogleEvent("c", "Cal", "#fff", {
        id: "a",
        start: { date: "2026-07-31" },
        end: { date: "2026-08-01" },
    })!
    eq(timeLabel(allDay), "all day")
    const timed = mapGoogleEvent("c", "Cal", "#fff", {
        id: "t",
        start: { dateTime: "2026-07-31T09:05:00" },
        end: { dateTime: "2026-07-31T10:30:00" },
    })!
    eq(timeLabel(timed), "09:05–10:30")
})
