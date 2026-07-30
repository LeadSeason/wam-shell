import { test, eq } from "./framework"
import { dayTimeline, startTimeLabel } from "../src/lib/harvest"
import type { Entry } from "../src/lib/harvest"

const entry = (over: Partial<Entry>): Entry => ({
    id: 1,
    spentDate: "2026-07-30",
    hours: 1,
    hoursWithoutTimer: null,
    timerStartedAt: null,
    startedTime: null,
    isRunning: false,
    notes: "",
    updatedAt: "2026-07-30T09:00:00Z",
    projectId: 1,
    projectName: "P",
    taskId: 1,
    taskName: "T",
    clientName: "C",
    ...over,
})

test("dayTimeline: timed entries sort by start time ascending", () => {
    const rows = dayTimeline([
        entry({ id: 1, startedTime: "11:00" }),
        entry({ id: 2, startedTime: "8:30" }),
        entry({ id: 3, startedTime: "1:00pm" }),
    ])
    eq(
        rows.map(e => e.id),
        [2, 1, 3],
    )
})

test("dayTimeline: timerStartedAt wins over startedTime", () => {
    const rows = dayTimeline([
        entry({ id: 1, startedTime: "8:00", timerStartedAt: "2026-07-30T10:00:00" }),
        entry({ id: 2, startedTime: "9:00" }),
    ])
    eq(
        rows.map(e => e.id),
        [2, 1],
    )
})

test("dayTimeline: manual entries (no start) slot in by updatedAt", () => {
    const rows = dayTimeline([
        entry({ id: 1, startedTime: "14:00" }),
        entry({ id: 2, updatedAt: "2026-07-30T10:30:00Z" }),
        entry({ id: 3, updatedAt: "2026-07-30T16:00:00Z" }),
    ])
    eq(
        rows.map(e => e.id),
        [2, 1, 3],
    )
})

test("dayTimeline: running entries stay in the timeline", () => {
    const rows = dayTimeline([
        entry({ id: 1, startedTime: "14:20", isRunning: true }),
        entry({ id: 2, startedTime: "8:30" }),
    ])
    eq(
        rows.map(e => e.id),
        [2, 1],
    )
    eq(rows[1].isRunning, true)
})

test("startTimeLabel: 24h and 12h clocks, manual entries", () => {
    eq(startTimeLabel(entry({ startedTime: "09:15" })), "09:15")
    eq(startTimeLabel(entry({ startedTime: "3:00pm" })), "15:00")
    eq(startTimeLabel(entry({ startedTime: "12:00am" })), "00:00")
    eq(startTimeLabel(entry({})), "")
})
