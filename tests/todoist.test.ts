import { test, eq } from "./framework"
import { isOverdue, dueLabel, taskData, newArrivals } from "../src/lib/todoist"

// fixed "now": 2026-08-01 12:00 local
const now = new Date(2026, 7, 1, 12, 0, 0).getTime()

test("todoist isOverdue: date and datetime semantics", () => {
    eq(isOverdue({ date: "2026-07-31" }, now), true)
    eq(isOverdue({ date: "2026-08-01" }, now), false) // due today is not overdue
    eq(isOverdue({ date: "2026-08-02" }, now), false)
    // no Z suffix: local time, matching the local-day comparison
    eq(isOverdue({ datetime: "2026-07-31T23:59:00" }, now), true)
    eq(isOverdue({ datetime: "2026-08-05T10:00:00" }, now), false)
    eq(isOverdue(null, now), false)
    eq(isOverdue({}, now), false)
    eq(isOverdue({ date: "garbage" }, now), false)
})

test("todoist dueLabel: overdue, timed today, all-day today", () => {
    eq(dueLabel({ date: "2026-07-30", string: "Jul 30" }, now), "Overdue · Jul 30")
    eq(dueLabel({ datetime: "2026-08-01T15:30:00Z" }, now).startsWith("Today · "), true)
    eq(dueLabel({ date: "2026-08-01" }, now), "Today")
    eq(dueLabel(null, now), "")
})

test("todoist taskData: maps a scheduled task, skips unscheduled", () => {
    const raw = {
        id: "12345",
        content: "Water the plants",
        due: { date: "2026-07-31", datetime: "2026-07-31T14:00:00", string: "Jul 31" },
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
    // all-day tasks (no due time) are not scheduled: dropped
    eq(taskData({ ...raw, due: { date: "2026-08-01" } }, now), null)
    // unusable shapes are dropped
    eq(taskData({ id: "1" }, now), null)
    eq(taskData({ content: "x" }, now), null)
})

test("todoist newArrivals: only brand-new task ids", () => {
    const prev = [{ id: "todoist:1" }, { id: "todoist:2" }]
    const next = [{ id: "todoist:2" }, { id: "todoist:3" }]
    eq(newArrivals(prev, next), ["todoist:3"])
    eq(newArrivals(prev, prev), [])
})
