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
    createdAt: "2026-07-30T09:00:00Z",
    updatedAt: "2026-07-30T09:00:00Z",
    projectId: 1,
    projectName: "P",
    taskId: 1,
    taskName: "T",
    clientName: "C",
    ...over,
})

test("dayTimeline: timed entries sort by start time descending (Harvest order)", () => {
    const rows = dayTimeline([
        entry({ id: 1, startedTime: "11:00" }),
        entry({ id: 2, startedTime: "8:30" }),
        entry({ id: 3, startedTime: "1:00pm" }),
    ])
    eq(
        rows.map(e => e.id),
        [3, 1, 2],
    )
})

test("dayTimeline: timerStartedAt wins over startedTime", () => {
    const rows = dayTimeline([
        entry({ id: 1, startedTime: "8:00", timerStartedAt: "2026-07-30T10:00:00" }),
        entry({ id: 2, startedTime: "9:00" }),
    ])
    eq(
        rows.map(e => e.id),
        [1, 2],
    )
})

test("dayTimeline: manual entries (no start) slot in by createdAt", () => {
    const rows = dayTimeline([
        entry({ id: 1, startedTime: "14:00" }),
        entry({
            id: 2,
            createdAt: "2026-07-30T10:30:00Z",
            // a later edit must not move the row
            updatedAt: "2026-07-30T18:00:00Z",
        }),
        entry({ id: 3, createdAt: "2026-07-30T16:00:00Z" }),
    ])
    eq(
        rows.map(e => e.id),
        [3, 1, 2],
    )
})

test("dayTimeline: identical start times tie-break deterministically", () => {
    const rows = dayTimeline([
        entry({ id: 9, startedTime: "14:00", createdAt: "2026-07-30T14:00:30Z" }),
        entry({ id: 4, startedTime: "14:00", createdAt: "2026-07-30T14:00:10Z" }),
    ])
    eq(
        rows.map(e => e.id),
        [9, 4],
    )
})

test("dayTimeline: running entries stay in the timeline", () => {
    const rows = dayTimeline([
        entry({ id: 1, startedTime: "14:20", isRunning: true }),
        entry({ id: 2, startedTime: "8:30" }),
    ])
    eq(
        rows.map(e => e.id),
        [1, 2],
    )
    eq(rows[0].isRunning, true)
})

test("startTimeLabel: 24h and 12h clocks, manual entries", () => {
    eq(startTimeLabel(entry({ startedTime: "09:15" })), "09:15")
    eq(startTimeLabel(entry({ startedTime: "3:00pm" })), "15:00")
    eq(startTimeLabel(entry({ startedTime: "12:00am" })), "00:00")
    eq(startTimeLabel(entry({})), "")
})
