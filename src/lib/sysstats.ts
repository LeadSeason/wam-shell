import { createState } from "gnim"
import { createPoll } from "ags/time"
import { readFile } from "ags/file"
import { exec } from "ags/process"
import GLib from "gi://GLib?version=2.0"
import Config from "../config"
import { streamLines } from "./utils"

// System performance stats, polled on quicksettings.stats_interval.
// History targets a ~32s window, capped at 64 bars.

const INTERVAL = Config.quicksettings.statsInterval
const HISTORY = Math.min(64, Math.max(24, Math.round(32000 / INTERVAL)))

export const [cpu, setCpu] = createState(0)
export const [ram, setRam] = createState(0)
export const [gpu, setGpu] = createState<number | null>(null) // null = n/a
export const [gpuTemp, setGpuTemp] = createState(0)
export const [vram, setVram] = createState<[number, number]>([0, 0]) // used,total MiB
export const [ramSize, setRamSize] = createState<[number, number]>([0, 0]) // used,total GB
export const [loadAvg, setLoadAvg] = createState(0)
export const [netDown, setNetDown] = createState(0) // bytes/s
export const [netUp, setNetUp] = createState(0)     // bytes/s

export const [cpuHist, setCpuHist] = createState<{ v: number }[]>([])
export const [ramHist, setRamHist] = createState<{ v: number }[]>([])
export const [gpuHist, setGpuHist] = createState<{ v: number }[]>([])

// samples are objects so gnim's For sees unique identities
// (plain numbers repeat and trip "duplicate keys")
const push = (hist: { v: number }[], set: (v: { v: number }[]) => void, v: number) =>
    set([...hist, { v }].slice(-HISTORY))

// /proc/stat: user nice system idle iowait irq softirq steal
let prevCpu: { idle: number, total: number } | null = null
function readCpu(): number {
    const fields = readFile("/proc/stat").split("\n")[0]
        .split(/\s+/).slice(1).map(Number)
    const idle = fields[3] + fields[4]
    const total = fields.reduce((a, b) => a + b, 0)
    let pct = 0
    if (prevCpu && total > prevCpu.total)
        pct = 100 * (1 - (idle - prevCpu.idle) / (total - prevCpu.total))
    prevCpu = { idle, total }
    return Math.round(pct)
}

function readRam(): number {
    const meminfo = readFile("/proc/meminfo")
    const total = Number(meminfo.match(/MemTotal:\s+(\d+)/)?.[1] ?? 0)
    const avail = Number(meminfo.match(/MemAvailable:\s+(\d+)/)?.[1] ?? 0)
    if (!total) return 0
    const toGB = (kb: number) => Math.round(kb / 1024 / 1024 * 10) / 10
    setRamSize([toGB(total - avail), toGB(total)])
    return Math.round(100 * (1 - avail / total))
}

function readLoadAvg(): number {
    return Number(readFile("/proc/loadavg").split(" ")[0]) || 0
}

// /proc/net/dev: skip loopback and container/bridge interfaces
let prevNet: { rx: number, tx: number } | null = null
function readNet(intervalSec: number): [number, number] {
    let rx = 0, tx = 0
    for (const line of readFile("/proc/net/dev").split("\n").slice(2)) {
        const m = line.match(/^\s*([^:]+):\s*(.*)$/)
        if (!m) continue
        const iface = m[1].trim()
        if (iface === "lo" || iface.startsWith("docker")
            || iface.startsWith("br-") || iface.startsWith("veth")) continue
        const fields = m[2].split(/\s+/)
        rx += Number(fields[0])
        tx += Number(fields[8])
    }
    let down = 0, up = 0
    if (prevNet) {
        down = Math.max(0, (rx - prevNet.rx) / intervalSec)
        up = Math.max(0, (tx - prevNet.tx) / intervalSec)
    }
    prevNet = { rx, tx }
    return [Math.round(down), Math.round(up)]
}

// probe once: no point spawning nvidia-smi at all without one
const hasNvidia = (() => {
    try { exec("which nvidia-smi"); return true } catch { return false }
})()

const poll = createPoll("", INTERVAL, () => {
    const step = (label: string, fn: () => void) => {
        try { fn() } catch (e) { console.warn(`sysstats ${label}:`, e) }
    }
    step("cpu", () => {
        const c = readCpu()
        setCpu(c)
        push(cpuHist.get(), setCpuHist, c)
    })
    step("ram", () => {
        const r = readRam()
        setRam(r)
        push(ramHist.get(), setRamHist, r)
    })
    step("load", () => setLoadAvg(readLoadAvg()))
    step("net", () => {
        const [down, up] = readNet(INTERVAL / 1000)
        setNetDown(down)
        setNetUp(up)
    })
    return ""
})

// GPU stats come from ONE long-lived nvidia-smi in loop mode; the old
// per-tick spawn was the shell's most frequent fork. Same CSV fields as
// the one-shot query, one line per interval.
const GPU_CMD = [
    "nvidia-smi",
    "--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total",
    "--format=csv,noheader,nounits",
    `--loop-ms=${Math.max(1, Math.round(INTERVAL))}`,
]

// restart on death (driver reloads kill the stream), but cap attempts
// so a persistently failing nvidia-smi can't fork-loop. Any received
// line proves the driver is healthy, so it resets the budget.
const GPU_RESTART_DELAY = 5000
const GPU_MAX_RESTARTS = 5
let gpuRestarts = 0

function handleGpuLine(line: string) {
    gpuRestarts = 0
    const [util, temp, vramUsed, vramTotal] = line.split(",").map(Number)
    if ([util, temp, vramUsed, vramTotal].some(isNaN)) {
        // "[N/A]" during driver transitions: hide the row until it recovers
        setGpu(null)
        return
    }
    setGpu(util)
    setGpuTemp(temp)
    setVram([vramUsed, vramTotal])
    push(gpuHist.get(), setGpuHist, util)
}

function scheduleGpuRestart() {
    setGpu(null)
    if (gpuRestarts >= GPU_MAX_RESTARTS) {
        console.warn("sysstats gpu: nvidia-smi keeps dying, giving up")
        return
    }
    gpuRestarts++
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, GPU_RESTART_DELAY, () => {
        startGpuStream()
        return GLib.SOURCE_REMOVE
    })
}

function startGpuStream() {
    const proc = streamLines(GPU_CMD, handleGpuLine, scheduleGpuRestart)
    if (!proc) scheduleGpuRestart()
}

// createPoll is lazy until subscribed; keep it alive while stats are on
// (panel lists are authoritative: a "stats" entry in any [[panel]]
// renders the widget regardless of the legacy toggles)
if (Config.quicksettings.showStats || Config.quicksettings.statsOnPanel
    || Config.panels.some(p =>
        [...p.left, ...p.center, ...p.right].includes("stats"))) {
    poll.subscribe(() => { })
    if (hasNvidia) startGpuStream()
}

export function formatRate(bytesPerSec: number): string {
    if (bytesPerSec >= 1024 * 1024)
        return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`
    if (bytesPerSec >= 1024)
        return `${Math.round(bytesPerSec / 1024)} KB/s`
    return `${bytesPerSec} B/s`
}
