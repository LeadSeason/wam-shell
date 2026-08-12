import { test, eq } from "./framework"
import {
    applySample,
    parseEnergyTotals,
    pruneDays,
    formatWh,
    TrackerState,
} from "../src/lib/energyTotals"

const st = (prevUwh: number | null, days: Record<string, number> = {}): TrackerState => ({
    prevUwh,
    days,
})

test("applySample: first sample is a baseline only", () => {
    const s = st(null)
    eq(applySample(s, { uwh: 50_000_000, discharging: true }, "2026-08-12"), false)
    eq(s.days, {})
    eq(s.prevUwh, 50_000_000)
})

test("applySample: discharge delta is credited to the day", () => {
    const s = st(50_000_000)
    eq(applySample(s, { uwh: 49_000_000, discharging: true }, "2026-08-12"), true)
    eq(s.days["2026-08-12"], 1) // 1 Wh
    eq(applySample(s, { uwh: 48_500_000, discharging: true }, "2026-08-12"), true)
    eq(s.days["2026-08-12"], 1.5)
})

test("applySample: charging refills are not consumption", () => {
    const s = st(40_000_000)
    eq(applySample(s, { uwh: 45_000_000, discharging: false }, "2026-08-12"), false)
    eq(s.days, {})
    eq(s.prevUwh, 45_000_000)
})

test("applySample: gauge rising while discharging is a recalibration, clamped", () => {
    const s = st(40_000_000)
    eq(applySample(s, { uwh: 41_000_000, discharging: true }, "2026-08-12"), false)
    eq(s.days, {})
    // and the new reading becomes the baseline
    eq(applySample(s, { uwh: 40_500_000, discharging: true }, "2026-08-12"), true)
    eq(s.days["2026-08-12"], 0.5)
})

test("applySample: day rollover starts a new bucket", () => {
    const s = st(50_000_000, { "2026-08-11": 30 })
    applySample(s, { uwh: 49_000_000, discharging: true }, "2026-08-12")
    eq(s.days, { "2026-08-11": 30, "2026-08-12": 1 })
})

test("parseEnergyTotals: valid entries kept, junk dropped", () => {
    const data = parseEnergyTotals({
        days: {
            "2026-08-12": 42.1,
            "not-a-day": 5,
            "2026-08-13": -1,
            "2026-08-14": "lots",
        },
        lastUwh: 48_000_000,
    })
    eq(data.days, { "2026-08-12": 42.1 })
    eq(data.lastUwh, 48_000_000)
    eq(parseEnergyTotals({}).lastUwh, null)
    eq(parseEnergyTotals(null).days, {})
})

test("pruneDays: keeps the newest keys", () => {
    const days: Record<string, number> = {}
    for (let i = 1; i <= 100; i++) days[`2026-01-${String(i).padStart(2, "0")}`] = i
    const pruned = pruneDays(days, 90)
    eq(Object.keys(pruned).length, 90)
    eq(pruned["2026-01-01"], undefined)
    eq(pruned["2026-01-100"], 100)
})

test("formatWh: one decimal", () => {
    eq(formatWh(0), "0.0 Wh")
    eq(formatWh(42.14), "42.1 Wh")
})
