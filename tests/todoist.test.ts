import { test, eq } from "./framework"
import {
    isOverdue,
    dueLabel,
    taskData,
    newArrivals,
    buildReminderMap,
    snoozeDelayMs,
} from "../src/lib/todoist"

// fixed "now": 2026-08-01 12:00 local
const now = new Date(2026, 7, 1, 12, 0, 0).getTime()

test("todoist isOverdue: date and datetime semantics", () => {
    eq(isOverdue({ date: "2026-07-31" }, now), true)
    eq(isOverdue({ date: "2026-08-01" }, now), false) // due today is not overdue
    eq(isOverdue({ date: "2026-08-02" }, now), false)
    // v1: the due time lives in due.date (floating local)
    eq(isOverdue({ date: "2026-07-31T23:59:00" }, now), true)
    eq(isOverdue({ date: "2026-08-05T10:00:00" }, now), false)
    // legacy v2 datetime field still accepted
    eq(isOverdue({ datetime: "2026-07-31T23:59:00" }, now), true)
    eq(isOverdue(null, now), false)
    eq(isOverdue({}, now), false)
    eq(isOverdue({ date: "garbage" }, now), false)
})

test("todoist dueLabel: overdue, timed today, all-day today, tomorrow", () => {
    eq(dueLabel({ date: "2026-07-30", string: "Jul 30" }, now), "Overdue · Jul 30")
    eq(dueLabel({ datetime: "2026-08-01T15:30:00Z" }, now).startsWith("Today · "), true)
    eq(dueLabel({ date: "2026-08-01T15:30:00" }, now), "Today · 15:30")
    eq(dueLabel({ date: "2026-08-01" }, now), "Today")
    eq(dueLabel({ date: "2026-08-02" }, now), "Tomorrow")
    eq(dueLabel({ date: "2026-08-02T10:00:00" }, now), "Tomorrow · 10:00")
    eq(dueLabel(null, now), "")
})

test("todoist taskData: maps timed tasks, skips all-day and due-less", () => {
    const raw = {
        id: "12345",
        content: "Water the plants",
        due: { date: "2026-07-31T14:00:00", string: "Jul 31" },
    }
    eq(taskData(raw, now), {
        id: "todoist:12345",
        provider: "todoist",
        time: Date.parse("2026-07-31T14:00:00") / 1000,
        appName: "Todoist",
        summary: "Water the plants",
        body: "Overdue · Jul 31",
        iconName: "todoist-symbolic",
        // v1 drops the url field: constructed from the id
        url: "https://todoist.com/app/task/12345",
    })
    // legacy v2 datetime field maps too
    eq(
        taskData(
            {
                ...raw,
                due: { date: "2026-07-31", datetime: "2026-07-31T14:00:00", string: "Jul 31" },
            },
            now,
        )?.time,
        Date.parse("2026-07-31T14:00:00") / 1000,
    )
    // all-day tasks (no due time) are out of scope: dropped
    eq(taskData({ ...raw, due: { date: "2026-08-01" } }, now), null)
    // unusable shapes are dropped
    eq(taskData({ id: "1" }, now), null)
    eq(taskData({ content: "x" }, now), null)
    eq(taskData({ ...raw, due: null }, now), null)
})

test("todoist newArrivals: only brand-new task ids", () => {
    const prev = [{ id: "todoist:1" }, { id: "todoist:2" }]
    const next = [{ id: "todoist:2" }, { id: "todoist:3" }]
    eq(newArrivals(prev, next), ["todoist:3"])
    eq(newArrivals(prev, prev), [])
})

test("todoist buildReminderMap: groups fire times by task, skips junk", () => {
    const map = buildReminderMap([
        // the API precomputes the fire time into the reminder's due.date
        { item_id: "1", due: { date: "2026-08-04T08:30:00" }, is_deleted: false },
        { item_id: "1", due: { date: "2026-08-04T07:00:00" }, is_deleted: false },
        { item_id: "2", due: { datetime: "2026-08-04T09:00:00" }, is_deleted: false },
        { item_id: "3", due: { date: "2026-08-04T10:00:00" }, is_deleted: true },
        { item_id: "4", due: { date: "garbage" }, is_deleted: false },
        { due: { date: "2026-08-04T11:00:00" }, is_deleted: false },
    ])
    eq(map.get("1"), [Date.parse("2026-08-04T07:00:00"), Date.parse("2026-08-04T08:30:00")])
    eq(map.get("2"), [Date.parse("2026-08-04T09:00:00")])
    eq(map.has("3"), false, "deleted reminder skipped")
    eq(map.has("4"), false, "unparseable fire time skipped")
    eq(map.size, 2)
})

test("todoist snoozeDelayMs: full length, capped at due, past due", () => {
    const min30 = 30 * 60_000
    // due beyond the snooze window: the full duration
    eq(snoozeDelayMs(now + 2 * 3_600_000, now, 30), min30)
    // due sooner than the window: capped at the due time ("whichever
    // comes first")
    eq(snoozeDelayMs(now + 10 * 60_000, now, 30), 10 * 60_000)
    // exactly at the boundary: the cap is the due delta
    eq(snoozeDelayMs(now + min30, now, 30), min30)
    // already past due: the full duration (no zero/negative delay)
    eq(snoozeDelayMs(now - 60_000, now, 30), min30)
    eq(snoozeDelayMs(now, now, 30), min30)
    // honors the configured length
    eq(snoozeDelayMs(now + 2 * 3_600_000, now, 10), 10 * 60_000)
})
