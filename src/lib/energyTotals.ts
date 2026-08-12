import { createState } from "gnim"
import GLib from "gi://GLib?version=2.0"
import Config from "../config"
import { isFile } from "./utils"
import { writeFileAtomic } from "./atomicWrite"
import { timeoutAdd, sourceRemove } from "./metrics"
import { registerDispose } from "./lifecycle"

// Battery energy consumed per day (Wh), persisted.
//
// The battery gauge's energy_now is a cumulative-ish absolute value,
// so ANY poll interval captures all consumption as deltas — the
// interval only sets how much is lost to a crash between saves. That
// is why this does not ride powerDetails' poll: that one runs only
// while the power pane is visible, and a totals tracker that goes
// blind whenever the pane closes would silently under-count. One
// sysfs read every 15s is the whole cost.
//
// Only deltas while the gauge reports "Discharging" count: charging
// refills the tank, it is not consumption. The last gauge reading is
// persisted alongside the days, so a shell restart loses one 15s
// window at most, not the whole delta.

const STORE_PATH = `${Config.instanceCacheDir}/energytotals.json`
const LOG_TAG = "energytotals"
const KEEP_DAYS = 90
const POLL_MS = 15000
const SAVE_MS = 60000

export interface EnergyTotalsData {
    days: Record<string, number> // Wh consumed that day
    lastUwh: number | null // last gauge reading, for restart deltas
}

const read = (path: string): string => {
    try {
        const [, bytes] = GLib.file_get_contents(path)
        return new TextDecoder().decode(bytes).trim()
    } catch {
        return ""
    }
}

// battery supply dir: energy_now (µWh) directly, or charge_now (µAh)
// × voltage_now (µV) / 1e6 = µWh. Probe with an actual READ — like
// the RAPL counter these can exist but be unreadable
const supplyDir = ["/sys/class/power_supply/BAT0", "/sys/class/power_supply/BAT1"].find(d => {
    if (Number(read(`${d}/energy_now`)) > 0) return true
    return Number(read(`${d}/charge_now`)) > 0 && Number(read(`${d}/voltage_now`)) > 0
})
export const hasBatt = supplyDir !== undefined

function readGaugeUwh(): number {
    // the sync exception-safe read, not readFileAsync: a battery with
    // no energy_now must fall through to charge×voltage, not throw
    // out of the tick before the fallback is even tried
    const energy = Number(read(`${supplyDir}/energy_now`))
    if (energy > 0) return energy
    const charge = Number(read(`${supplyDir}/charge_now`))
    const voltage = Number(read(`${supplyDir}/voltage_now`))
    return (charge * voltage) / 1e6
}

export interface Sample {
    uwh: number
    discharging: boolean
}

export interface TrackerState {
    prevUwh: number | null
    days: Record<string, number>
}

/**
 * Fold one gauge sample into the day buckets. Returns true when Wh
 * were actually added — callers use it as their dirty flag (the
 * bucket is mutated IN PLACE; an identity comparison cannot tell).
 *
 * A gauge reading with no previous one is a baseline only. The gauge
 * going UP while discharging is a recalibration, not negative
 * consumption — clamped to zero.
 */
export function applySample(st: TrackerState, sample: Sample, dayKey: string): boolean {
    let added = false
    if (st.prevUwh !== null && sample.discharging && sample.uwh < st.prevUwh) {
        const wh = (st.prevUwh - sample.uwh) / 1e6
        st.days[dayKey] = (st.days[dayKey] ?? 0) + wh
        added = true
    }
    st.prevUwh = sample.uwh
    return added
}

// validate per entry and drop the bad ones, like netTotals' parser
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/
export function parseEnergyTotals(raw: unknown): EnergyTotalsData {
    const days: Record<string, number> = {}
    const src = (raw as any)?.days
    if (src && typeof src === "object") {
        for (const [key, v] of Object.entries(src)) {
            if (DAY_KEY.test(key) && typeof v === "number" && v >= 0) days[key] = v
        }
    }
    const lastUwh = (raw as any)?.lastUwh
    return {
        days: pruneDays(days),
        lastUwh: typeof lastUwh === "number" && lastUwh >= 0 ? lastUwh : null,
    }
}

// keep the newest `keep` day keys (ISO dates sort chronologically)
export function pruneDays(days: Record<string, number>, keep = KEEP_DAYS) {
    const keys = Object.keys(days).sort()
    if (keys.length <= keep) return { ...days }
    const out: Record<string, number> = {}
    for (const k of keys.slice(-keep)) out[k] = days[k]
    return out
}

export function formatWh(wh: number): string {
    return `${wh.toFixed(1)} Wh`
}

export const [todayWh, setTodayWh] = createState(0)

const tracker: TrackerState = { prevUwh: null, days: {} }
let dirty = false
let lastSave = 0
let pollSource = 0

const dayKey = () => GLib.DateTime.new_now_local().format("%Y-%m-%d") ?? ""

function publish() {
    setTodayWh(tracker.days[dayKey()] ?? 0)
}

function save() {
    dirty = false
    lastSave = GLib.get_monotonic_time() / 1000
    tracker.days = pruneDays(tracker.days)
    const data: EnergyTotalsData = { days: tracker.days, lastUwh: tracker.prevUwh }
    writeFileAtomic(STORE_PATH, JSON.stringify(data)).catch(e =>
        console.warn(`${LOG_TAG}: failed writing store:`, e),
    )
}

function tick() {
    try {
        const uwh = readGaugeUwh()
        if (uwh <= 0) return
        const sample: Sample = {
            uwh,
            discharging: read(`${supplyDir}/status`) === "Discharging",
        }
        if (applySample(tracker, sample, dayKey())) dirty = true
        publish()
        if (dirty && GLib.get_monotonic_time() / 1000 - lastSave >= SAVE_MS) save()
    } catch (e) {
        console.warn(`${LOG_TAG}: poll failed:`, e)
    }
}

function load() {
    if (!isFile(STORE_PATH)) return
    try {
        const data = parseEnergyTotals(
            JSON.parse(new TextDecoder().decode(GLib.file_get_contents(STORE_PATH)[1])),
        )
        tracker.days = data.days
        tracker.prevUwh = data.lastUwh
    } catch (e) {
        console.warn(`${LOG_TAG}: failed reading store:`, e)
    }
}

// convention for lib modules with long-lived sources (see AGENTS.md)
export function dispose() {
    if (pollSource) {
        sourceRemove(pollSource)
        pollSource = 0
    }
    if (dirty) save()
}

// no battery (or an unreadable gauge) means no poll and no store:
// the state just stays at zero and the tile hides
if (hasBatt) {
    load()
    publish()
    pollSource = timeoutAdd(LOG_TAG + ":poll", GLib.PRIORITY_DEFAULT, POLL_MS, () => {
        tick()
        return GLib.SOURCE_CONTINUE
    })
    tick() // baseline now, not 15s from now
}

registerDispose("energytotals", dispose)
