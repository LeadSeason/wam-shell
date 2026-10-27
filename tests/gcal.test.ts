import GLib from "gi://GLib?version=2.0"
import { test, eq } from "./framework"
import {
    dayKey,
    eventDays,
    mapGoogleEvent,
    resolveAttending,
    resolveReminderMinutes,
    timeLabel,
    agendaGroups,
    monthGrid,
    isVisible,
    isoWeekNumber,
    dayLabel,
    parseVisibilityOverrides,
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

test("gcal eventDays: no duplicate/missing days across a DST transition", () => {
    // spans the EU fall-back (2026-10-25): stepping absolute 24h lands
    // at 23:00 on the same local day there — a duplicate key, and the
    // last day dropped. Zones without a transition in the span pass
    // trivially
    const start = new Date(2026, 9, 23, 12).getTime()
    const end = new Date(2026, 9, 28, 12).getTime()
    eq(eventDays(start, end, false), [
        "2026-10-23",
        "2026-10-24",
        "2026-10-25",
        "2026-10-26",
        "2026-10-27",
        "2026-10-28",
    ])
})

test("gcal mapGoogleEvent: cancelled events are dropped", () => {
    eq(mapGoogleEvent("me@example.com", "c", "Cal", "#fff", [], { status: "cancelled" }), null)
})

test("gcal mapGoogleEvent: timed event with local dateTime", () => {
    const e = mapGoogleEvent("me@example.com", "c1", "Work", "#a1b2c3", [], {
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
    const e = mapGoogleEvent("me@example.com", "c", "Cal", "#fff", [], {
        id: "x",
        start: { dateTime: "2026-07-31T10:00:00" },
        end: { dateTime: "2026-07-31T11:00:00" },
    })
    eq(e?.summary, "(no title)")
})

test("gcal mapGoogleEvent: all-day event uses exclusive end date", () => {
    const e = mapGoogleEvent("me@example.com", "c", "Cal", "#fff", [], {
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
        mapGoogleEvent("me@example.com", "c", "Cal", "#fff", [], {
            id: "bad",
            start: {},
            end: {},
        }),
        null,
    )
})

test("gcal resolveReminderMinutes: overrides are the event's reminders", () => {
    // popup entries banner; non-popup methods don't
    eq(
        resolveReminderMinutes(
            {
                useDefault: false,
                overrides: [
                    { method: "popup", minutes: 10 },
                    { method: "email", minutes: 30 },
                ],
            },
            [5],
        ),
        [10],
    )
    // several popup overrides all banner
    eq(
        resolveReminderMinutes(
            {
                useDefault: false,
                overrides: [
                    { method: "popup", minutes: 5 },
                    { method: "popup", minutes: 60 },
                ],
            },
            [],
        ),
        [5, 60],
    )
})

test("gcal resolveReminderMinutes: explicit silence beats defaults", () => {
    // email-only overrides: a deliberate choice, not missing data
    eq(
        resolveReminderMinutes(
            { useDefault: false, overrides: [{ method: "email", minutes: 30 }] },
            [5],
        ),
        null,
    )
    // reminders turned off for the event
    eq(resolveReminderMinutes({ useDefault: false }, [5]), null)
})

test("gcal resolveReminderMinutes: useDefault falls to the calendar, then config", () => {
    // the calendar's default popup reminders
    eq(resolveReminderMinutes({ useDefault: true }, [10]), [10])
    eq(resolveReminderMinutes({ useDefault: true }, [5, 30]), [5, 30])
    // a calendar with none: no information — the config fallback applies
    eq(resolveReminderMinutes({ useDefault: true }, []), [])
    // a missing reminders object reads as useDefault
    eq(resolveReminderMinutes(undefined, [10]), [10])
})

test("gcal mapGoogleEvent: url and resolved reminders land on the event", () => {
    const e = mapGoogleEvent("me@example.com", "c", "Cal", "#fff", [15], {
        id: "ev1",
        summary: "Standup",
        start: { dateTime: "2026-07-31T10:00:00" },
        end: { dateTime: "2026-07-31T10:30:00" },
        htmlLink: "https://calendar.google.com/event?eid=ev1",
        reminders: { useDefault: true },
    })!
    eq(e.url, "https://calendar.google.com/event?eid=ev1")
    eq(e.reminderMinutes, [15])
    // absent htmlLink and explicit silence
    const silent = mapGoogleEvent("me@example.com", "c", "Cal", "#fff", [15], {
        id: "ev2",
        start: { dateTime: "2026-07-31T10:00:00" },
        end: { dateTime: "2026-07-31T10:30:00" },
        reminders: { useDefault: false },
    })!
    eq(silent.url, "")
    eq(silent.reminderMinutes, null)
})

test("gcal timeLabel: all day vs timed range", () => {
    const allDay = mapGoogleEvent("me@example.com", "c", "Cal", "#fff", [], {
        id: "a",
        start: { date: "2026-07-31" },
        end: { date: "2026-08-01" },
    })!
    eq(timeLabel(allDay), "all day")
    const timed = mapGoogleEvent("me@example.com", "c", "Cal", "#fff", [], {
        id: "t",
        start: { dateTime: "2026-07-31T09:05:00" },
        end: { dateTime: "2026-07-31T10:30:00" },
    })!
    eq(timeLabel(timed), "09:05–10:30")
})

// agenda: three events on two days, one spanning midnight, one before
const ev = (id: string, start: string, end: string) =>
    mapGoogleEvent("me@example.com", "c", "Cal", "#fff", [], {
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
    eq(
        groups.map(g => g.day),
        ["2026-07-31", "2026-08-01", "2026-08-02"],
    )
    eq(
        groups[0].events.map(e => e.summary),
        ["e1"],
    )
    eq(
        groups[1].events.map(e => e.summary),
        ["e1"],
    ) // the spanning event repeats
    eq(
        groups[2].events.map(e => e.summary),
        ["e2"],
    )
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
    eq(
        grid.every(w => w.length === 7),
        true,
    )
    // Monday of the first row is June 29
    eq(grid[0][0].key, "2026-06-29")
    eq(grid[0][0].inMonth, false)
    eq(grid[0][2].key, "2026-07-01")
    eq(grid[0][2].inMonth, true)
    // Friday July 31 sits in week 5 (row index 4), Friday column
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
        defaultReminderMinutes: [],
    }
    // default: visible
    eq(isVisible(cal, {}, []), true)
    // hidden by bare name and by account-scoped name
    eq(isVisible(cal, {}, ["Birthdays"]), false)
    eq(isVisible(cal, {}, ["me@example.com:Birthdays"]), false)
    eq(isVisible(cal, {}, ["other@example.com:Birthdays"]), true)
    // session override wins over config in both directions (keys are
    // account-scoped: two accounts can share a calendar id)
    eq(isVisible(cal, { "me@example.com:c1": true }, ["Birthdays"]), true)
    eq(isVisible(cal, { "me@example.com:c1": false }, []), false)
    // another account's override for the same bare id does not leak
    eq(isVisible(cal, { "other@example.com:c1": false }, []), true)
})

test("gcal parseVisibilityOverrides: bad shapes drop, booleans keep", () => {
    eq(parseVisibilityOverrides(""), {})
    eq(parseVisibilityOverrides("not json"), {})
    eq(parseVisibilityOverrides("null"), {})
    eq(parseVisibilityOverrides('["a"]'), {})
    eq(parseVisibilityOverrides('"str"'), {})
    // non-boolean values are dropped, the rest survives
    eq(parseVisibilityOverrides('{"a:c1": false, "a:c2": true, "a:c3": "yes", "a:c4": 0}'), {
        "a:c1": false,
        "a:c2": true,
    })
})

test("gcal isoWeekNumber: ISO-8601 week numbers", () => {
    const d = (y: number, m0: number, day: number) => new Date(y, m0, day)
    // 2026-01-01 is a Thursday: ISO week 1 of 2026
    eq(isoWeekNumber(d(2026, 0, 1)), 1)
    // 2025-12-29 (Mon) belongs to ISO week 1 of 2026
    eq(isoWeekNumber(d(2025, 11, 29)), 1)
    // 2025-01-01 (Wed) is ISO week 1 of 2025
    eq(isoWeekNumber(d(2025, 0, 1)), 1)
    // 2024-12-30 (Mon) is ISO week 1 of 2025; the day before is week 52 of 2024
    eq(isoWeekNumber(d(2024, 11, 30)), 1)
    eq(isoWeekNumber(d(2024, 11, 29)), 52)
    // a mid-year sanity check: 2026-08-03 (Mon) is week 32
    eq(isoWeekNumber(d(2026, 7, 3)), 32)
    // 2021-01-01 (Fri) is week 53 of 2020
    eq(isoWeekNumber(d(2021, 0, 1)), 53)
})

// The weekday is spelled out in English rather than taken from %a,
// which follows the locale — "Today" and "Tomorrow" never can, so the
// agenda otherwise switched language two rows in ("tis, 05.08.2026").
// Same rule, and now the same list, as the center's day dividers.
test("gcal dayLabel: relative names, then an English weekday", () => {
    eq(dayLabel("2026-08-07", "2026-08-07"), "Today")
    eq(dayLabel("2026-08-08", "2026-08-07"), "Tomorrow")
    // 2026-08-05 is a Wednesday
    eq(dayLabel("2026-08-05", "2026-08-07"), "Wed, 05.08.2026")
    // month rollover: the "tomorrow" comparison has to survive it
    eq(dayLabel("2026-09-01", "2026-08-31"), "Tomorrow")
    // 2026-01-04 is a Sunday — the Monday-first list's last entry
    eq(dayLabel("2026-01-04", "2026-08-07"), "Sun, 04.01.2026")
    // 2026-01-05 is a Monday — its first
    eq(dayLabel("2026-01-05", "2026-08-07"), "Mon, 05.01.2026")
})

// a minimal timed event raw for resolveAttending/mapGoogleEvent runs
const timedRaw = (extra: any = {}) => ({
    id: "ev",
    summary: "Meeting",
    start: { dateTime: new Date(d(31, 13)).toISOString() },
    end: { dateTime: new Date(d(31, 14)).toISOString() },
    ...extra,
})

test("gcal resolveAttending: a self guest entry attends, unless declined", () => {
    eq(
        resolveAttending(
            timedRaw({ attendees: [{ self: true, responseStatus: "accepted" }] }),
            false,
        ),
        true,
    )
    // needsAction/tentative still count: you ARE on the guest list
    eq(resolveAttending(timedRaw({ attendees: [{ self: true }] }), false), true)
    eq(
        resolveAttending(
            timedRaw({ attendees: [{ self: true, responseStatus: "declined" }] }),
            false,
        ),
        false,
    )
})

test("gcal resolveAttending: organizing attends even without a guest entry", () => {
    eq(resolveAttending(timedRaw({ organizer: { self: true } }), false), true)
})

test("gcal resolveAttending: other people's guest lists don't count", () => {
    eq(
        resolveAttending(
            timedRaw({ attendees: [{ email: "a@x.com" }, { email: "b@x.com" }] }),
            false,
        ),
        false,
    )
    eq(resolveAttending(timedRaw({ organizer: { email: "a@x.com" } }), false), false)
})

test("gcal resolveAttending: guest-less events are personal only on the primary calendar", () => {
    eq(resolveAttending(timedRaw(), true), true)
    // the same shape on a shared/subscribed calendar is merely visible
    eq(resolveAttending(timedRaw(), false), false)
})

test("gcal mapGoogleEvent: attending lands on the event", () => {
    const invited = mapGoogleEvent("me@example.com", "shared", "Team", "#fff", [], {
        ...timedRaw(),
        attendees: [{ self: true, responseStatus: "tentative" }],
    })
    eq(invited?.attending, true)
    const shared = mapGoogleEvent("me@example.com", "shared", "Team", "#fff", [], timedRaw())
    eq(shared?.attending, false)
    const personal = mapGoogleEvent(
        "me@example.com",
        "me@example.com",
        "Me",
        "#fff",
        [],
        timedRaw(),
        true,
    )
    eq(personal?.attending, true)
})

// ---------------------------------------------------------------------
// Zone-pinned cases. The `timezone` key threads one Zone through every
// day-funnel above; the default is the machine's, which is what every
// existing test here exercises without saying so. These pin the other
// case: the same instant, resolved in two zones far enough apart that
// the answers must differ. Both zones are named, so the assertions hold
// on any machine in any zone.
// ---------------------------------------------------------------------
const NY = GLib.TimeZone.new("America/New_York")!
const STOCKHOLM = GLib.TimeZone.new("Europe/Stockholm")!

// 2026-01-15 23:30 UTC: 18:30 on the 15th in New York, 00:30 on the 16th
// in Stockholm
const EDGE = Date.UTC(2026, 0, 15, 23, 30, 0)

test("gcal dayKey: an explicit zone moves the day, not just the clock", () => {
    eq(dayKey(EDGE, NY), "2026-01-15", "New York is still on the 15th")
    eq(dayKey(EDGE, STOCKHOLM), "2026-01-16", "Stockholm has rolled to the 16th")
    // and without an explicit zone it is whatever this machine is set to
    const local = new Date(EDGE)
    eq(
        dayKey(EDGE),
        `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`,
        "the default is the host's zone",
    )
})

test("gcal eventDays: a midnight-crossing event is one day or two, per zone", () => {
    // 2026-01-16 03:00-06:00 UTC. Stockholm is UTC+1 that week: 04:00 ->
    // 07:00, entirely on the 16th. New York is UTC-5: 22:00 on the 15th
    // -> 01:00 on the 16th, so the span crosses New York's midnight and
    // the end-exclusive last covered instant (00:59:59.999) is on the
    // 16th. One event, one day in one zone and two in the other.
    const s = Date.UTC(2026, 0, 16, 3, 0)
    const e = Date.UTC(2026, 0, 16, 6, 0)
    eq(eventDays(s, e, false, STOCKHOLM), ["2026-01-16"], "Stockholm: one day")
    eq(eventDays(s, e, false, NY), ["2026-01-15", "2026-01-16"], "New York: two days")
    // a longer span walks every day in the given zone
    eq(
        eventDays(Date.UTC(2026, 0, 15, 20), Date.UTC(2026, 0, 17, 20), false, STOCKHOLM),
        ["2026-01-15", "2026-01-16", "2026-01-17"],
        "Stockholm: a two-day span",
    )
    eq(
        eventDays(Date.UTC(2026, 0, 15, 20), Date.UTC(2026, 0, 17, 20), false, NY),
        ["2026-01-15", "2026-01-16", "2026-01-17"],
        "New York: the same span, same days",
    )
})

test("gcal eventDays: an end exactly on a midnight starts the next day only in that zone", () => {
    // 23:00 -> 00:00 UTC. Stockholm's 00:00 is 2026-01-16; the last
    // covered instant is therefore still on the 16th, so one day.
    const s = Date.UTC(2026, 0, 15, 23, 0)
    const e = Date.UTC(2026, 0, 16, 0, 0)
    eq(eventDays(s, e, false, STOCKHOLM), ["2026-01-16"], "exclusive end")
    eq(eventDays(s, e, false, NY), ["2026-01-15"], "the same end, in New York")
})

test("gcal timeLabel: reads the clock in the given zone", () => {
    // a timed event renders as a start–end range, both ends in the zone
    const e = { allDay: false, startMs: EDGE, endMs: EDGE + 30 * 60_000 } as never
    eq(timeLabel(e, STOCKHOLM), "00:30–01:00", "Stockholm")
    eq(timeLabel(e, NY), "18:30–19:00", "New York")
    eq(timeLabel({ allDay: true } as never, STOCKHOLM), "all day", "all-day events have no clock")
})

test("gcal monthGrid: leading cells are civil dates, aligned Monday-first", () => {
    // 2026-01-01 is a Thursday, so January's grid opens on Mon 29 Dec
    for (const z of [STOCKHOLM, NY]) {
        const g = monthGrid(2026, 0, z)
        eq(g.length, 6, "fixed six rows")
        eq(g[0].length, 7, "seven cells in a row")
        eq(g[0][0].key, "2025-12-29", "opens on the preceding Monday")
        eq(g[0][0].inMonth, false, "the leading cell is off-month")
        eq(g[0][3].key, "2026-01-01", "Thursday is the 1st")
        eq(g[0][3].inMonth, true)
        eq(g[0][6].key, "2026-01-04", "Sunday closes the first row")
        eq(g[5][6].key, "2026-02-08", "the grid ends on Sunday 8 Feb")
        eq(g[5][6].inMonth, false, "trailing cell is off-month")
    }
})

test("gcal monthGrid: February's leading offset follows the year's weekday", () => {
    // 2026-02-01 is a Sunday, so February opens on Mon 26 Jan
    eq(monthGrid(2026, 1, STOCKHOLM)[0][0].key, "2026-01-26", "stockholm")
    eq(monthGrid(2026, 1, NY)[0][0].key, "2026-01-26", "new york — the same civil grid")
    // a leap February: 2024-02-01 is a Thursday, so the grid opens on
    // Mon 29 Jan and the 29th itself appears
    eq(monthGrid(2024, 1, STOCKHOLM)[0][0].key, "2024-01-29", "leap year leading cell")
    eq(monthGrid(2024, 1, STOCKHOLM)[0][3].num, 1, "the 1st is a Thursday")
})

// dayLabel's `z` is threaded for the default only: the arguments are
// already day KEYS, and a calendar-day add does not depend on the zone,
// so the answer is the same everywhere. Worth pinning — it is the one
// gcal helper whose zone parameter changes nothing, and a reader could
// reasonably assume otherwise.
test("gcal dayLabel: a day key's label does not depend on the zone", () => {
    for (const z of [STOCKHOLM, NY]) {
        eq(dayLabel("2026-08-07", "2026-08-07", z), "Today", "same day")
        eq(dayLabel("2026-08-08", "2026-08-07", z), "Tomorrow", "next day")
        // 2026-08-05 is a Wednesday; the weekday is read in UTC so no
        // configured zone can shift it
        eq(dayLabel("2026-08-05", "2026-08-07", z), "Wed, 05.08.2026", "earlier day")
        // month rollover
        eq(dayLabel("2026-09-01", "2026-08-31", z), "Tomorrow", "rollover")
    }
})
