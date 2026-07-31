import { test, eq } from "./framework"
import {
    dayKey,
    eventDays,
    mapGoogleEvent,
    timeLabel,
    agendaGroups,
    monthGrid,
    isVisible,
} from "../src/lib/gcal"

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
    eq(mapGoogleEvent("me@example.com", "c", "Cal", "#fff", { status: "cancelled" }), null)
})

test("gcal mapGoogleEvent: timed event with local dateTime", () => {
    const e = mapGoogleEvent("me@example.com", "c1", "Work", "#a1b2c3", {
        id: "ev1",
        summary: "Standup",
        start: { dateTime: "2026-07-31T10:00:00" },
        end: { dateTime: "2026-07-31T10:30:00" },
    })
    eq(e?.allDay, false)
    eq(e?.days, ["2026-07-31"])
    eq(e?.calendarName, "Work")
    eq(e?.color, "#a1b2c3")
    eq(e?.account, "me@example.com")
    eq(e?.id, "me@example.com/c1:ev1")
})

test("gcal mapGoogleEvent: missing summary falls back", () => {
    const e = mapGoogleEvent("me@example.com", "c", "Cal", "#fff", {
        id: "x",
        start: { dateTime: "2026-07-31T10:00:00" },
        end: { dateTime: "2026-07-31T11:00:00" },
    })
    eq(e?.summary, "(no title)")
})

test("gcal mapGoogleEvent: all-day event uses exclusive end date", () => {
    const e = mapGoogleEvent("me@example.com", "c", "Cal", "#fff", {
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
        mapGoogleEvent("me@example.com", "c", "Cal", "#fff", {
            id: "bad",
            start: {},
            end: {},
        }),
        null,
    )
})

test("gcal timeLabel: all day vs timed range", () => {
    const allDay = mapGoogleEvent("me@example.com", "c", "Cal", "#fff", {
        id: "a",
        start: { date: "2026-07-31" },
        end: { date: "2026-08-01" },
    })!
    eq(timeLabel(allDay), "all day")
    const timed = mapGoogleEvent("me@example.com", "c", "Cal", "#fff", {
        id: "t",
        start: { dateTime: "2026-07-31T09:05:00" },
        end: { dateTime: "2026-07-31T10:30:00" },
    })!
    eq(timeLabel(timed), "09:05–10:30")
})

// agenda: three events on two days, one spanning midnight, one before
const ev = (id: string, start: string, end: string) =>
    mapGoogleEvent("me@example.com", "c", "Cal", "#fff", {
        id,
        summary: id,
        start: { dateTime: start },
        end: { dateTime: end },
    })!

test("gcal agendaGroups: days ascending, empty days skipped, fromDay honored", () => {
    const events = [
        ev("e2", "2026-08-02T10:00:00", "2026-08-02T11:00:00"),
        ev("e1", "2026-07-31T23:00:00", "2026-08-01T01:00:00"), // spans 2 days
        ev("e0", "2026-07-30T09:00:00", "2026-07-30T10:00:00"), // before fromDay
    ]
    const groups = agendaGroups(events, "2026-07-31", "2026-07-31")
    eq(groups.map(g => g.day), ["2026-07-31", "2026-08-01", "2026-08-02"])
    eq(groups[0].events.map(e => e.summary), ["e1"])
    eq(groups[1].events.map(e => e.summary), ["e1"]) // the spanning event repeats
    eq(groups[2].events.map(e => e.summary), ["e2"])
})

test("gcal agendaGroups: Today/Tomorrow labels, dates beyond", () => {
    const events = [
        ev("t", "2026-07-31T10:00:00", "2026-07-31T11:00:00"),
        ev("tm", "2026-08-01T10:00:00", "2026-08-01T11:00:00"),
        ev("d", "2026-08-03T10:00:00", "2026-08-03T11:00:00"),
    ]
    const groups = agendaGroups(events, "2026-07-31", "2026-07-31")
    eq(groups[0].label, "Today")
    eq(groups[1].label, "Tomorrow")
    eq(groups[2].label.includes("03.08.2026"), true)
})

test("gcal agendaGroups: empty when nothing is upcoming", () => {
    eq(agendaGroups([], "2026-07-31", "2026-07-31"), [])
    const past = [ev("p", "2026-07-30T10:00:00", "2026-07-30T11:00:00")]
    eq(agendaGroups(past, "2026-07-31", "2026-07-31"), [])
})

test("gcal monthGrid: 6x7 Monday-first grid covering the month", () => {
    const grid = monthGrid(2026, 6) // July 2026 starts on a Wednesday
    eq(grid.length, 6)
    eq(grid.every(w => w.length === 7), true)
    // Monday of the first row is June 29
    eq(grid[0][0].key, "2026-06-29")
    eq(grid[0][0].inMonth, false)
    eq(grid[0][3].key, "2026-07-01")
    eq(grid[0][3].inMonth, true)
    // Friday July 31 sits in week 5 col 4
    eq(grid[4][4].key, "2026-07-31")
    // every day of the month appears exactly once, marked inMonth
    const nums = grid.flat().filter(d => d.inMonth).length
    eq(nums, 31)
})

test("gcal monthGrid: Saturday-start month keeps Monday-first grid", () => {
    const grid = monthGrid(2026, 7) // August 2026 starts on a Saturday
    eq(grid[0][0].key, "2026-07-27") // Monday of the same week
    eq(grid[0][0].inMonth, false)
    eq(grid[0][5].key, "2026-08-01")
    eq(grid[0][5].inMonth, true)
})

test("gcal isVisible: config names, account-scoped names, overrides", () => {
    const cal = {
        id: "c1",
        summary: "Birthdays",
        color: "#fff",
        account: "me@example.com",
    }
    // default: visible
    eq(isVisible(cal, {}, []), true)
    // hidden by bare name and by account-scoped name
    eq(isVisible(cal, {}, ["Birthdays"]), false)
    eq(isVisible(cal, {}, ["me@example.com:Birthdays"]), false)
    eq(isVisible(cal, {}, ["other@example.com:Birthdays"]), true)
    // session override wins over config in both directions
    eq(isVisible(cal, { c1: true }, ["Birthdays"]), true)
    eq(isVisible(cal, { c1: false }, []), false)
})
