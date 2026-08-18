import GLib from "gi://GLib?version=2.0"
import { test, eq } from "./framework"
import { buildFeed, compareRows, FeedRow, OrderedRow } from "../src/widgets/notifications/feed"

// fixed "now": 2026-08-06 14:30 local
const NOW = GLib.DateTime.new_local(2026, 8, 6, 14, 30, 0)!.to_unix()
const HOUR = 3600

let n = 0
const row = (appName: string, time: number): FeedRow => ({
    key: `k${n++}`,
    time,
    appName,
    iconName: `${appName}-symbolic`,
})

// what each block is, compactly, so the assertions read as structure
const shape = (blocks: ReturnType<typeof buildFeed>) =>
    blocks.map(b => (b.kind === "divider" ? `--${b.label}--` : `${b.appName}x${b.rows.length}`))

test("buildFeed: empty in, empty out", () => {
    eq(buildFeed([], NOW), [])
})

test("buildFeed: a single day gets no dividers", () => {
    const rows = [row("a", NOW - HOUR), row("b", NOW - 2 * HOUR)]
    eq(shape(buildFeed(rows, NOW)), ["ax1", "bx1"])
})

test("buildFeed: short runs stay unfolded, one group each", () => {
    // two from one app is not worth a disclosure
    const rows = [row("a", NOW - HOUR), row("a", NOW - 2 * HOUR), row("b", NOW - 3 * HOUR)]
    eq(shape(buildFeed(rows, NOW)), ["ax1", "ax1", "bx1"])
})

test("buildFeed: a run at the threshold folds", () => {
    const rows = [
        row("ci", NOW - HOUR),
        row("ci", NOW - 2 * HOUR),
        row("ci", NOW - 3 * HOUR),
        row("b", NOW - 4 * HOUR),
    ]
    eq(shape(buildFeed(rows, NOW)), ["cix3", "bx1"])
})

test("buildFeed: only CONSECUTIVE rows fold", () => {
    // the same app either side of another app is two separate runs —
    // folding them together would reorder the list
    const rows = [
        row("ci", NOW - HOUR),
        row("ci", NOW - 2 * HOUR),
        row("b", NOW - 3 * HOUR),
        row("ci", NOW - 4 * HOUR),
    ]
    eq(shape(buildFeed(rows, NOW)), ["cix1", "cix1", "bx1", "cix1"])
})

test("buildFeed: rows keep their order inside a group", () => {
    const rows = [row("ci", NOW - HOUR), row("ci", NOW - 2 * HOUR), row("ci", NOW - 3 * HOUR)]
    const blocks = buildFeed(rows, NOW)
    eq(blocks.length, 1)
    eq(blocks[0].kind === "group" ? blocks[0].rows.map(r => r.key) : [], [
        rows[0].key,
        rows[1].key,
        rows[2].key,
    ])
})

test("buildFeed: more than one day gets dividers", () => {
    const yesterday = GLib.DateTime.new_local(2026, 8, 5, 10, 0, 0)!.to_unix()
    const rows = [row("a", NOW - HOUR), row("b", yesterday)]
    eq(shape(buildFeed(rows, NOW)), ["--Today--", "ax1", "--Yesterday--", "bx1"])
})

test("buildFeed: a run never folds across a day divider", () => {
    const yesterday = GLib.DateTime.new_local(2026, 8, 5, 10, 0, 0)!.to_unix()
    const rows = [
        row("ci", NOW - HOUR),
        row("ci", NOW - 2 * HOUR),
        row("ci", NOW - 3 * HOUR),
        row("ci", yesterday),
        row("ci", yesterday - HOUR),
        row("ci", yesterday - 2 * HOUR),
    ]
    eq(shape(buildFeed(rows, NOW)), ["--Today--", "cix3", "--Yesterday--", "cix3"])
})

test("buildFeed: groupMin is honoured", () => {
    const rows = [row("a", NOW - HOUR), row("a", NOW - 2 * HOUR)]
    eq(shape(buildFeed(rows, NOW, 2)), ["ax2"])
})

test("buildFeed: group keys are stable and unique", () => {
    const rows = [row("a", NOW - HOUR), row("b", NOW - 2 * HOUR), row("a", NOW - 3 * HOUR)]
    const keys = buildFeed(rows, NOW).map(b => b.key)
    eq(keys.length, new Set(keys).size, "no duplicate keys")
})

// ----------------------------------------------------------- compareRows

const orow = (appName: string, time: number, soonestFirst = false): OrderedRow => ({
    ...row(appName, time),
    soonestFirst,
})

// sorted keys, compactly
const order = (rows: OrderedRow[]) => [...rows].sort(compareRows).map(r => r.key)

test("compareRows: plain rows sort newest first", () => {
    const a = orow("a", NOW - HOUR)
    const b = orow("b", NOW - 2 * HOUR)
    eq(order([b, a]), [a.key, b.key])
})

test("compareRows: soonest-first rows sort next-event first", () => {
    const soon = orow("cal", NOW + HOUR, true)
    const later = orow("cal", NOW + 2 * HOUR, true)
    eq(order([later, soon]), [soon.key, later.key])
})

test("compareRows: the soonest-first block sits above the feed", () => {
    // even an in-progress event (its start is in the PAST) stays above
    // the newest notification — the block is keyed on the group, not
    // on which timestamp happens to be larger
    const notif = orow("chat", NOW - 60)
    const inProgress = orow("cal", NOW - 30 * 60, true)
    const next = orow("cal", NOW + HOUR, true)
    eq(order([notif, inProgress, next]), [inProgress.key, next.key, notif.key])
})

test("compareRows: transitivity survives a mixed list", () => {
    // the case a row-pair direction flip would get wrong: calendar
    // events either side of a notification's timestamp
    const n1 = orow("chat", NOW - HOUR)
    const n2 = orow("chat", NOW - 3 * HOUR)
    const e1 = orow("cal", NOW - 30 * 60, true) // started, in progress
    const e2 = orow("cal", NOW + 2 * HOUR, true)
    const e3 = orow("cal", NOW + 5 * HOUR, true)
    eq(order([n2, e3, n1, e2, e1]), [e1.key, e2.key, e3.key, n1.key, n2.key])
})
