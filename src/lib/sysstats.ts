import { createState } from "gnim"
import { createPoll } from "ags/time"
import { readFile } from "ags/file"
import { execAsync } from "ags/process"
import Config from "../config"

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

// probe once: no point spawning nvidia-smi every tick without one
const hasNvidia = (() => {
    try { exec("which nvidia-smi"); return true } catch { return false }
})()
let inFlight = false

const poll = createPoll("", INTERVAL, async () => {
    // don't overlap ticks when nvidia-smi is slow
    if (inFlight) return ""
    inFlight = true

    try {
    const step = (label: string, fn: () => void) => {
        try { fn() } catch (e) { console.error(`sysstats ${label}:`, e) }
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

    if (hasNvidia) try {
        const out = await execAsync([
            "nvidia-smi",
            "--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total",
            "--format=csv,noheader,nounits",
        ])
        const [util, temp, vramUsed, vramTotal] = out.trim().split(",").map(Number)
        setGpu(util)
        setGpuTemp(temp)
        setVram([vramUsed, vramTotal])
        push(gpuHist.get(), setGpuHist, util)
    } catch {
        setGpu(null) // driver hiccup: hide the row until it recovers
    }

    } finally {
        inFlight = false
    }
    return ""
})

// createPoll is lazy until subscribed; keep it alive while stats are on
if (Config.quicksettings.showStats || Config.quicksettings.statsOnPanel)
    poll.subscribe(() => { })

export function formatRate(bytesPerSec: number): string {
    if (bytesPerSec >= 1024 * 1024)
        return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`
    if (bytesPerSec >= 1024)
        return `${Math.round(bytesPerSec / 1024)} KB/s`
    return `${bytesPerSec} B/s`
}
