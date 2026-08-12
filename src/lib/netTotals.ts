import { createState } from "gnim"
import GLib from "gi://GLib?version=2.0"
import { readFileAsync } from "ags/file"
import Config from "../config"
import { isFile } from "./utils"
import { writeFileAtomic } from "./atomicWrite"
import { timeoutAdd, sourceRemove } from "./metrics"
import { registerDispose } from "./lifecycle"

// Cumulative bandwidth totals, persisted per day.
//
// /proc/net/dev counters are cumulative, so ANY poll interval captures
// every byte — the interval only sets how much is lost to a crash
// between saves. That is why this module does not ride sysstats' poll:
// that one is lazy (it stops when no stats widget is visible), and a
// totals tracker that goes blind whenever the bar hides "stats" would
// silently under-count. One file read every 15s is the whole cost.
//
// The store is a per-day record, pruned to KEEP_DAYS, so "today" and
// "this month" are sums over it and restart for free.

const STORE_PATH = `${Config.instanceCacheDir}/netstats.json`
const LOG_TAG = "nettotals"
const KEEP_DAYS = 90
const POLL_MS = 15000
const SAVE_MS = 60000

export interface DayTotals {
    rx: number
    tx: number
}

export interface NetTotalsData {
    days: Record<string, DayTotals>
}

// /proc/net/dev: skip loopback and container/bridge interfaces.
// Shared with sysstats' rate reader so the filter lives in one place.
export function sumNetDev(text: string): { rx: number; tx: number } {
    let rx = 0,
        tx = 0
    for (const line of text.split("\n").slice(2)) {
        const m = line.match(/^\s*([^:]+):\s*(.*)$/)
        if (!m) continue
        const iface = m[1].trim()
        if (
            iface === "lo" ||
            iface.startsWith("docker") ||
            iface.startsWith("br-") ||
            iface.startsWith("veth")
        )
            continue
        const fields = m[2].split(/\s+/)
        rx += Number(fields[0])
        tx += Number(fields[8])
    }
    return { rx, tx }
}

// validate per entry and drop the bad ones, like cache.ts's parser —
// a hand-edited or half-written file must not take the totals with it.
// The key must be an ISO day: the month sum matches on the YYYY-MM
// prefix, so a junk key could leak into it
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/
export function parseNetTotals(raw: unknown): NetTotalsData {
    const days: Record<string, DayTotals> = {}
    const src = (raw as any)?.days
    if (src && typeof src === "object") {
        for (const [key, v] of Object.entries(src)) {
            if (!DAY_KEY.test(key)) continue
            const rx = (v as any)?.rx
            const tx = (v as any)?.tx
            if (typeof rx === "number" && rx >= 0 && typeof tx === "number" && tx >= 0)
                days[key] = { rx, tx }
        }
    }
    return { days: pruneDays(days) }
}

// keep the newest `keep` day keys (ISO dates sort chronologically)
export function pruneDays(
    days: Record<string, DayTotals>,
    keep = KEEP_DAYS,
): Record<string, DayTotals> {
    const keys = Object.keys(days).sort()
    if (keys.length <= keep) return { ...days }
    const out: Record<string, DayTotals> = {}
    for (const k of keys.slice(-keep)) out[k] = days[k]
    return out
}

export interface TrackerState {
    prev: { rx: number; tx: number } | null
    days: Record<string, DayTotals>
}

/**
 * Fold one counter sample into the day buckets. Returns true when
 * bytes were actually added — callers use it as their dirty flag,
 * because an existing bucket is mutated IN PLACE and an identity
 * comparison cannot tell it changed.
 *
 * The first sample after start is a baseline only: counters count
 * since boot, and crediting them to today would report a day's worth
 * of traffic that happened before the shell (or the day) even started.
 * A counter going BACKWARDS is a reset (reboot, interface bounce):
 * the current value is then all the traffic since the reset, so it is
 * counted in full rather than rebased away.
 */
export function applySample(
    st: TrackerState,
    sample: { rx: number; tx: number },
    dayKey: string,
): boolean {
    let added = false
    if (st.prev) {
        const drx = sample.rx >= st.prev.rx ? sample.rx - st.prev.rx : sample.rx
        const dtx = sample.tx >= st.prev.tx ? sample.tx - st.prev.tx : sample.tx
        if (drx > 0 || dtx > 0) {
            const day = st.days[dayKey] ?? { rx: 0, tx: 0 }
            day.rx += drx
            day.tx += dtx
            st.days[dayKey] = day
            added = true
        }
    }
    st.prev = sample
    return added
}

export function formatBytes(n: number): string {
    if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
    if (n >= 1024) return `${Math.round(n / 1024)} KB`
    return `${n} B`
}

export const [todayRx, setTodayRx] = createState(0)
export const [todayTx, setTodayTx] = createState(0)
export const [monthRx, setMonthRx] = createState(0)
export const [monthTx, setMonthTx] = createState(0)

const tracker: TrackerState = { prev: null, days: {} }
let dirty = false
let lastSave = 0
let pollSource = 0

const dayKey = () => GLib.DateTime.new_now_local().format("%Y-%m-%d") ?? ""

function publish() {
    const key = dayKey()
    const today = tracker.days[key] ?? { rx: 0, tx: 0 }
    const monthPrefix = key.slice(0, 7) // "YYYY-MM"
    let mrx = 0,
        mtx = 0
    for (const [k, v] of Object.entries(tracker.days))
        if (k.startsWith(monthPrefix)) {
            mrx += v.rx
            mtx += v.tx
        }
    setTodayRx(today.rx)
    setTodayTx(today.tx)
    setMonthRx(mrx)
    setMonthTx(mtx)
}

function save() {
    dirty = false
    lastSave = GLib.get_monotonic_time() / 1000
    tracker.days = pruneDays(tracker.days)
    writeFileAtomic(STORE_PATH, JSON.stringify({ days: tracker.days })).catch(e =>
        console.warn(`${LOG_TAG}: failed writing store:`, e),
    )
}

async function tick() {
    try {
        const sample = sumNetDev(await readFileAsync("/proc/net/dev"))
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
        tracker.days = parseNetTotals(
            JSON.parse(new TextDecoder().decode(GLib.file_get_contents(STORE_PATH)[1])),
        ).days
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

// disabled means no poll and no store: the states just stay at zero
if (Config.netstats.enabled) {
    load()
    publish()
    pollSource = timeoutAdd("nettotals:poll", GLib.PRIORITY_DEFAULT, POLL_MS, () => {
        void tick()
        return GLib.SOURCE_CONTINUE
    })
    void tick() // baseline now, not 15s from now
}

registerDispose("nettotals", dispose)
