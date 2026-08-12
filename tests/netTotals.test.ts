import { test, eq, deepEqual } from "./framework"
import {
    sumNetDev,
    parseNetTotals,
    pruneDays,
    applySample,
    formatBytes,
    TrackerState,
} from "../src/lib/netTotals"

const NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000      10    0    0    0     0          0         0     2000      20    0    0    0     0       0          0
  eth0: 5000      50    0    0    0     0          0         0     7000      70    0    0    0     0       0          0
wlan0: 3000      30    0    0    0     0          0         0     1000      10    0    0    0     0       0          0
docker0: 999       9    0    0    0     0          0         0      999       9    0    0    0     0       0          0
br-abc: 888       8    0    0    0     0          0         0      888       8    0    0    0     0       0          0
veth12: 777       7    0    0    0     0          0         0      777       7    0    0    0     0       0          0
`

test("sumNetDev: sums real interfaces, skips lo and container/bridge ones", () => {
    const { rx, tx } = sumNetDev(NET_DEV)
    eq(rx, 8000) // eth0 + wlan0
    eq(tx, 8000)
})

test("sumNetDev: empty and header-only input sums to zero", () => {
    eq(sumNetDev("").rx, 0)
    eq(sumNetDev("Inter-|\n face |\n").tx, 0)
})

test("parseNetTotals: valid file round-trips", () => {
    const data = parseNetTotals({
        days: { "2026-08-10": { rx: 5, tx: 2 }, "2026-08-11": { rx: 7, tx: 3 } },
    })
    eq(data.days["2026-08-10"].rx, 5)
    eq(data.days["2026-08-11"].tx, 3)
})

test("parseNetTotals: garbage in, empty store out", () => {
    for (const raw of [null, undefined, 42, "x", {}, { days: null }, { days: [1, 2] }])
        eq(Object.keys(parseNetTotals(raw).days).length, 0, `raw=${JSON.stringify(raw)}`)
})

test("parseNetTotals: bad day entries are dropped, good ones survive", () => {
    const data = parseNetTotals({
        days: {
            "2026-08-10": { rx: 1, tx: 2 },
            "2026-08-11": { rx: 1 }, // missing tx
            "2026-08-12": { rx: -1, tx: 2 }, // negative
            "2026-08-13": { rx: "1", tx: 2 }, // wrong type
            "2026-08-14": 42, // not an object
            garbage: { rx: 1, tx: 2 }, // key is not an ISO day
        },
    })
    eq(Object.keys(data.days).length, 1)
    eq(data.days["2026-08-10"].tx, 2)
})

test("parseNetTotals: prunes to the newest 90 days", () => {
    const days: Record<string, { rx: number; tx: number }> = {}
    const d = new Date(2026, 0, 1)
    for (let i = 0; i < 100; i++) {
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
        days[key] = { rx: i, tx: 0 }
        d.setDate(d.getDate() + 1)
    }
    const keys = Object.keys(parseNetTotals({ days }).days)
    eq(keys.length, 90)
    eq(keys[0], "2026-01-11") // oldest ten are gone
    eq(keys[89], "2026-04-10")
})

test("pruneDays: at or under the cap is a copy, not a prune", () => {
    const days = { b: { rx: 1, tx: 0 }, a: { rx: 2, tx: 0 } }
    eq(deepEqual(pruneDays(days, 2), days), true)
    eq(pruneDays(days, 5) === days, false)
})

test("applySample: first sample is a baseline, not consumption", () => {
    const st: TrackerState = { prev: null, days: {} }
    applySample(st, { rx: 1000, tx: 500 }, "2026-08-11")
    eq(Object.keys(st.days).length, 0)
})

test("applySample: deltas accumulate into the day bucket", () => {
    const st: TrackerState = { prev: null, days: {} }
    applySample(st, { rx: 1000, tx: 500 }, "2026-08-11")
    applySample(st, { rx: 1300, tx: 800 }, "2026-08-11")
    applySample(st, { rx: 1400, tx: 900 }, "2026-08-11")
    eq(st.days["2026-08-11"].rx, 400)
    eq(st.days["2026-08-11"].tx, 400)
})

// the tracker's dirty flag IS this return value (an existing bucket is
// mutated in place — identity can't see the change)
test("applySample: reports whether bytes were folded in", () => {
    const st: TrackerState = { prev: null, days: {} }
    eq(applySample(st, { rx: 1000, tx: 0 }, "2026-08-11"), false) // baseline
    eq(applySample(st, { rx: 1000, tx: 0 }, "2026-08-11"), false) // no delta
    eq(applySample(st, { rx: 1500, tx: 0 }, "2026-08-11"), true) // real traffic
    // ...including into a bucket that already existed
    eq(applySample(st, { rx: 1600, tx: 0 }, "2026-08-11"), true)
})

test("applySample: a counter reset counts what accumulated since it", () => {
    const st: TrackerState = { prev: null, days: {} }
    applySample(st, { rx: 9000, tx: 8000 }, "2026-08-11")
    applySample(st, { rx: 250, tx: 100 }, "2026-08-11") // reboot in between
    eq(st.days["2026-08-11"].rx, 250)
    eq(st.days["2026-08-11"].tx, 100)
})

test("applySample: day rollover starts a new bucket", () => {
    const st: TrackerState = { prev: null, days: {} }
    applySample(st, { rx: 100, tx: 0 }, "2026-08-11")
    applySample(st, { rx: 200, tx: 0 }, "2026-08-11")
    applySample(st, { rx: 350, tx: 0 }, "2026-08-12")
    eq(st.days["2026-08-11"].rx, 100)
    eq(st.days["2026-08-12"].rx, 150)
})

test("formatBytes: picks a unit and precision per magnitude", () => {
    eq(formatBytes(0), "0 B")
    eq(formatBytes(512), "512 B")
    eq(formatBytes(2048), "2 KB")
    eq(formatBytes(12.4 * 1024 * 1024), "12.4 MB")
    eq(formatBytes(3 * 1024 * 1024 * 1024), "3.0 GB")
})
