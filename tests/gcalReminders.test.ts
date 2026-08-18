import { test, eq } from "./framework"
import { CalEvent, dayKey } from "../src/lib/gcal"
import { eventItemData, reminderFires } from "../src/lib/gcalReminders"

// fixed "now": 2026-08-17 12:00 local
const now = new Date(2026, 7, 17, 12, 0, 0).getTime()
const at = (h: number, min = 0) => new Date(2026, 7, 17, h, min).getTime()

const mkEvent = (
    startMs: number,
    endMs: number,
    reminderMinutes: number[] | null = [],
    over: Partial<CalEvent> = {},
): CalEvent => ({
    id: "me@example.com/c:ev",
    account: "me@example.com",
    calendarId: "c",
    calendarName: "Cal",
    color: "#fff",
    summary: "Meeting",
    startMs,
    endMs,
    allDay: false,
    url: "https://calendar.google.com/event?eid=ev",
    reminderMinutes,
    days: [dayKey(startMs)],
    ...over,
})

test("gcalReminders eventItemData: one ProviderItem per event", () => {
    const item = eventItemData(mkEvent(at(13), at(14)), now)
    eq(item.id, "gcal:me@example.com/c:ev")
    eq(item.provider, "calendar")
    eq(item.time, at(13) / 1000)
    eq(item.appName, "Cal")
    eq(item.summary, "Meeting")
    eq(item.body, "Today · 13:00–14:00")
    eq(item.iconName, "x-office-calendar-symbolic")
    eq(item.url, "https://calendar.google.com/event?eid=ev")
})

test("gcalReminders eventItemData: tomorrow's event is labeled Tomorrow", () => {
    const tomorrow = at(13) + 86_400_000
    eq(eventItemData(mkEvent(tomorrow, tomorrow + 3_600_000), now).body.includes("Tomorrow"), true)
})

test("gcalReminders eventItemData: actionable at the lead boundary and in progress", () => {
    // starts exactly remind_before_minutes (default 10) from now: actionable
    eq(eventItemData(mkEvent(now + 10 * 60_000, now + 70 * 60_000), now).actionable, true)
    // a minute beyond the lead: informational
    eq(eventItemData(mkEvent(now + 11 * 60_000, now + 71 * 60_000), now).actionable, false)
    // in progress
    eq(eventItemData(mkEvent(now - 30 * 60_000, now + 30 * 60_000), now).actionable, true)
    // over: history, not a need
    eq(eventItemData(mkEvent(now - 60_000, now - 30_000), now).actionable, false)
    // a zero-length event that already started needs nothing
    eq(eventItemData(mkEvent(now - 60_000, now - 60_000), now).actionable, false)
})

test("gcalReminders reminderFires: explicit silence banners nothing", () => {
    eq(reminderFires(mkEvent(at(13), at(14), null), 10), [])
})

test("gcalReminders reminderFires: no information falls back to the config lead", () => {
    eq(reminderFires(mkEvent(at(13), at(14), []), 10), [at(13) - 10 * 60_000, at(13)])
})

test("gcalReminders reminderFires: Google times plus the start", () => {
    eq(reminderFires(mkEvent(at(13), at(14), [5, 30]), 10), [
        at(13) - 5 * 60_000,
        at(13) - 30 * 60_000,
        at(13),
    ])
    // a reminder set exactly at the start dedupes with the at-start banner
    eq(reminderFires(mkEvent(at(13), at(14), [0]), 10), [at(13)])
})
