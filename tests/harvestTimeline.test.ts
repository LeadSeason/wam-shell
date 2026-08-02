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

test("dayTimeline: entries sort by creation time, not segment start", () => {
    const rows = dayTimeline([
        entry({ id: 1, startedTime: "11:00", createdAt: "2026-07-30T12:00:00Z" }),
        entry({ id: 2, startedTime: "8:30", createdAt: "2026-07-30T07:00:00Z" }),
        entry({ id: 3, startedTime: "1:00pm", createdAt: "2026-07-30T09:00:00Z" }),
    ])
    eq(
        rows.map(e => e.id),
        [2, 3, 1],
    )
})

test("dayTimeline: identical creation times tie-break by id", () => {
    const rows = dayTimeline([
        entry({ id: 9, createdAt: "2026-07-30T14:00:10Z" }),
        entry({ id: 4, createdAt: "2026-07-30T14:00:10Z" }),
    ])
    eq(
        rows.map(e => e.id),
        [4, 9],
    )
})

test("dayTimeline: manual entries (no start) slot in by createdAt", () => {
    const rows = dayTimeline([
        entry({ id: 1, startedTime: "14:00", createdAt: "2026-07-30T14:00:00Z" }),
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
        [2, 1, 3],
    )
})

test("dayTimeline: a resumed entry keeps its creation spot", () => {
    const rows = dayTimeline([
        entry({ id: 1, isRunning: true, createdAt: "2026-07-30T08:00:00Z" }),
        entry({ id: 2, createdAt: "2026-07-30T09:00:00Z" }),
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
