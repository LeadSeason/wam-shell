import { createState } from "gnim"
import { createPoll } from "ags/time"
import { readFileAsync } from "ags/file"
import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { timeoutAdd, sourceRemove } from "./metrics"
import { sumNetDev, formatBytes } from "./netTotals"
import Config from "../config"
import { streamLines } from "./streamLines"
import { registerDispose } from "./lifecycle"

// System performance stats, polled on quicksettings.stats_interval.
// History targets a ~32s window, capped at 64 bars.

const INTERVAL = Config.quicksettings.statsInterval
const HISTORY = Math.min(64, Math.max(24, Math.round(32000 / INTERVAL)))

export const [cpu, setCpu] = createState(0)
export const [ram, setRam] = createState(0)
export const [gpu, setGpu] = createState<number | null>(null) // null = n/a
export const [gpuTemp, setGpuTemp] = createState(0)
export const [gpuWatts, setGpuWatts] = createState(0) // package power draw, W
export const [vram, setVram] = createState<[number, number]>([0, 0]) // used,total MiB
export const [ramSize, setRamSize] = createState<[number, number]>([0, 0]) // used,total GB
export const [swapSize, setSwapSize] = createState<[number, number]>([0, 0]) // used,total GB
export const [loadAvg, setLoadAvg] = createState(0)
// PSI memory "some" avg60: the share of the last minute at least one
// task sat STALLED on memory. This, not swap usage, is what "everything
// feels sluggish" is — idle pages park in swap without hurting anything.
// null when the kernel has PSI off (psi=0)
export const [memPressure, setMemPressure] = createState<number | null>(null)

// avg60 percentages. Keyed on the 1-minute average on purpose: avg10
// spikes on every app launch and would flash the warning during normal
// use; >= WARN sustained over a minute is real pressure
export const MEM_PRESSURE_WARN = 5
export const MEM_PRESSURE_CRIT = 20

// pure parser, exported for tests: the "some" line's avg60 out of
// /proc/pressure/memory ("some avg10=0.00 avg60=0.05 avg300=0.21 total=…")
export function parseMemPressure(text: string): number | null {
    const m = text.match(/^some\s+.*\bavg60=([\d.]+)/m)
    return m ? Number(m[1]) : null
}

// probe once: PSI can be boot-disabled, and a missing file read every
// tick would log a warning per interval
const hasPsi = GLib.file_test("/proc/pressure/memory", GLib.FileTest.EXISTS)

// the biggest residents, formatted for the warning's "who to kill"
// line; empty whenever pressure is below WARN (nothing to act on)
export const [memHogs, setMemHogs] = createState("")

// pure parser, exported for tests: comm sits between the first '(' and
// the LAST ')' (it may itself contain spaces and parens); rss is field
// 24 — index 21 of what follows the ')' — in pages
export function parseProcStat(text: string): [string, number] | null {
    const open = text.indexOf("(")
    const close = text.lastIndexOf(")")
    if (open < 0 || close <= open) return null
    const comm = text.slice(open + 1, close)
    const rss = Number(
        text
            .slice(close + 1)
            .trim()
            .split(/\s+/)[21],
    )
    if (!comm || isNaN(rss)) return null
    return [comm, rss * 4096] // 4 KiB pages on every arch the shell runs on
}

// pure formatter, exported for tests: biggest first, top n, long comms
// truncated — the full name is one `ps` away, this line's job is pointing
export function formatTopMem(procs: [string, number][], n = 3): string {
    return procs
        .filter(([, rss]) => rss > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([comm, rss]) => {
            const name = comm.length > 16 ? `${comm.slice(0, 15)}…` : comm
            return `${name} ${formatBytes(rss)}`
        })
        .join(" · ")
}

// /proc walk for the biggest residents. Sync reads of kernel-generated
// tiny files, and only ever run while the warning can be on screen
function scanTopMem(): [string, number][] {
    const procs: [string, number][] = []
    let en: Gio.FileEnumerator | null = null
    try {
        en = Gio.File.new_for_path("/proc").enumerate_children(
            "standard::name",
            Gio.FileQueryInfoFlags.NONE,
            null,
        )
        let info: Gio.FileInfo | null
        while ((info = en.next_file(null)) !== null) {
            const pid = info.get_name()
            if (!/^\d+$/.test(pid)) continue
            const [ok, data] = GLib.file_get_contents(`/proc/${pid}/stat`)
            if (!ok) continue
            const p = parseProcStat(new TextDecoder().decode(data))
            if (p) procs.push(p)
        }
    } finally {
        en?.close(null)
    }
    return procs
}

export const [netDown, setNetDown] = createState(0) // bytes/s
export const [netUp, setNetUp] = createState(0) // bytes/s
export const [diskRead, setDiskRead] = createState(0) // bytes/s
export const [diskWrite, setDiskWrite] = createState(0) // bytes/s
export const [uptimeSeconds, setUptimeSeconds] = createState(0)

export const [cpuHist, setCpuHist] = createState<{ v: number }[]>([])
export const [ramHist, setRamHist] = createState<{ v: number }[]>([])
export const [gpuHist, setGpuHist] = createState<{ v: number }[]>([])

// samples are objects so gnim's For sees unique identities
// (plain numbers repeat and trip "duplicate keys")
const push = (hist: { v: number }[], set: (v: { v: number }[]) => void, v: number) =>
    set([...hist, { v }].slice(-HISTORY))

// /proc/stat: user nice system idle iowait irq softirq steal
let prevCpu: { idle: number; total: number } | null = null
async function readCpu(): Promise<number> {
    const fields = (await readFileAsync("/proc/stat"))
        .split("\n")[0]
        .split(/\s+/)
        .slice(1)
        .map(Number)
    const idle = fields[3] + fields[4]
    const total = fields.reduce((a, b) => a + b, 0)
    let pct = 0
    if (prevCpu && total > prevCpu.total)
        pct = 100 * (1 - (idle - prevCpu.idle) / (total - prevCpu.total))
    prevCpu = { idle, total }
    return Math.round(pct)
}

async function readRam(): Promise<number> {
    const meminfo = await readFileAsync("/proc/meminfo")
    const total = Number(meminfo.match(/MemTotal:\s+(\d+)/)?.[1] ?? 0)
    const avail = Number(meminfo.match(/MemAvailable:\s+(\d+)/)?.[1] ?? 0)
    const swapTotal = Number(meminfo.match(/SwapTotal:\s+(\d+)/)?.[1] ?? 0)
    const swapFree = Number(meminfo.match(/SwapFree:\s+(\d+)/)?.[1] ?? 0)
    if (!total) return 0
    const toGB = (kb: number) => Math.round((kb / 1024 / 1024) * 10) / 10
    setRamSize([toGB(total - avail), toGB(total)])
    setSwapSize([toGB(swapTotal - swapFree), toGB(swapTotal)])
    return Math.round(100 * (1 - avail / total))
}

async function readLoadAvg(): Promise<number> {
    return Number((await readFileAsync("/proc/loadavg")).split(" ")[0]) || 0
}

async function readUptime(): Promise<number> {
    return Math.floor(Number((await readFileAsync("/proc/uptime")).split(" ")[0]) || 0)
}

// whole disks only: partitions (nvme0n1p1, sda1, mmcblk0p1) would
// double-count, and loop/ram/zram/dm aren't physical I/O
const WHOLE_DISK = /^(nvme\d+n\d+|mmcblk\d+|x?vd[a-z]+|sd[a-z]+)$/
const SECTOR_BYTES = 512

// pure parser, exported for tests: sums /proc/diskstats sectors
// (read = field 6, written = field 10) over whole disks only
export function sumDiskSectors(text: string): { rSec: number; wSec: number } {
    let rSec = 0,
        wSec = 0
    for (const line of text.split("\n")) {
        const f = line.trim().split(/\s+/)
        if (f.length < 10 || !WHOLE_DISK.test(f[2])) continue
        rSec += Number(f[5]) || 0
        wSec += Number(f[9]) || 0
    }
    return { rSec, wSec }
}

// same elapsed-time divisor as readNet — ticks slip
let prevDisk: { rSec: number; wSec: number; t: number } | null = null
async function readDisk(): Promise<[number, number]> {
    const { rSec, wSec } = sumDiskSectors(await readFileAsync("/proc/diskstats"))
    const now = GLib.get_monotonic_time() / 1000 // us -> ms
    let read = 0,
        write = 0
    if (prevDisk && now > prevDisk.t) {
        const dt = (now - prevDisk.t) / 1000
        read = Math.max(0, ((rSec - prevDisk.rSec) * SECTOR_BYTES) / dt)
        write = Math.max(0, ((wSec - prevDisk.wSec) * SECTOR_BYTES) / dt)
    }
    prevDisk = { rSec, wSec, t: now }
    return [Math.round(read), Math.round(write)]
}

// the rate divisor is the actual elapsed time: ticks slip while a
// previous sample is in flight, and a fixed INTERVAL would inflate it
let prevNet: { rx: number; tx: number; t: number } | null = null
async function readNet(): Promise<[number, number]> {
    const { rx, tx } = sumNetDev(await readFileAsync("/proc/net/dev"))
    const now = GLib.get_monotonic_time() / 1000 // us -> ms
    let down = 0,
        up = 0
    if (prevNet && now > prevNet.t) {
        const dt = (now - prevNet.t) / 1000
        down = Math.max(0, (rx - prevNet.rx) / dt)
        up = Math.max(0, (tx - prevNet.tx) / dt)
    }
    prevNet = { rx, tx, t: now }
    return [Math.round(down), Math.round(up)]
}

// probe once: no point spawning nvidia-smi at all without one
const hasNvidia = GLib.find_program_in_path("nvidia-smi") !== null

const poll = createPoll("", INTERVAL, () => {
    const step = (label: string, fn: () => void | Promise<void>) => {
        try {
            const p = fn()
            // async steps throw after step() returned; log them like
            // the sync failures instead of losing them to unhandledrejection
            if (p instanceof Promise) p.catch(e => console.warn(`sysstats ${label}:`, e))
        } catch (e) {
            console.warn(`sysstats ${label}:`, e)
        }
    }
    step("cpu", async () => {
        const c = await readCpu()
        setCpu(c)
        push(cpuHist.get(), setCpuHist, c)
    })
    step("ram", async () => {
        const r = await readRam()
        setRam(r)
        push(ramHist.get(), setRamHist, r)
    })
    step("load", async () => setLoadAvg(await readLoadAvg()))
    if (hasPsi)
        step("psi", async () => {
            const p = parseMemPressure(await readFileAsync("/proc/pressure/memory"))
            setMemPressure(p)
            // the /proc walk rides the pressure gate: it only runs while
            // the warning can be on screen
            setMemHogs(p !== null && p >= MEM_PRESSURE_WARN ? formatTopMem(scanTopMem()) : "")
        })
    step("uptime", async () => setUptimeSeconds(await readUptime()))
    step("disk", async () => {
        const [read, write] = await readDisk()
        setDiskRead(read)
        setDiskWrite(write)
    })
    step("net", async () => {
        const [down, up] = await readNet()
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
    "--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw",
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
    const [util, temp, vramUsed, vramTotal, watts] = line.split(",").map(Number)
    if ([util, temp, vramUsed, vramTotal].some(isNaN)) {
        // "[N/A]" during driver transitions: hide the row until it recovers
        setGpu(null)
        return
    }
    setGpu(util)
    setGpuTemp(temp)
    setVram([vramUsed, vramTotal])
    // power.draw can be [N/A] on GPUs that don't report it; keep last
    if (!isNaN(watts)) setGpuWatts(watts)
    push(gpuHist.get(), setGpuHist, util)
}

let gpuRestartSource = 0
let gpuProc: Gio.Subprocess | null = null
let gpuDisposed = false
// the visibility engines' intent: a force_exit WE ordered (pane
// closed) must not look like a crash to the restart path
let gpuWanted = false

function scheduleGpuRestart() {
    setGpu(null)
    // clear the handle of the just-died process (crash or our own kill)
    gpuProc = null
    if (gpuDisposed || !gpuWanted) return
    if (gpuRestarts >= GPU_MAX_RESTARTS) {
        console.warn("sysstats gpu: nvidia-smi keeps dying, giving up")
        return
    }
    gpuRestarts++
    gpuRestartSource = timeoutAdd(
        "sysstats:gpuRestart",
        GLib.PRIORITY_DEFAULT,
        GPU_RESTART_DELAY,
        () => {
            gpuRestartSource = 0
            startGpuStream()
            return GLib.SOURCE_REMOVE
        },
    )
}

function startGpuStream() {
    if (gpuDisposed || !gpuWanted) return
    // a pending restart must not double-spawn alongside us
    if (gpuRestartSource) {
        sourceRemove(gpuRestartSource)
        gpuRestartSource = 0
    }
    if (gpuProc) return
    const proc = streamLines(GPU_CMD, handleGpuLine, () => {
        // only the process we still own may schedule a restart: a stale
        // exit from an already-replaced process must not wipe the new
        // handle and spawn a duplicate
        if (gpuProc === proc) scheduleGpuRestart()
    })
    gpuProc = proc
    if (!gpuProc) scheduleGpuRestart()
}

// convention for lib modules with long-lived sources (see AGENTS.md)
export function dispose() {
    gpuDisposed = true
    if (gpuRestartSource) {
        sourceRemove(gpuRestartSource)
        gpuRestartSource = 0
    }
    gpuProc?.force_exit()
    gpuProc = null
    // unsubscribing the keep-alive drops the count to zero, which
    // clears createPoll's interval (ags/lib/time.ts)
    stopPoll?.()
    stopPoll = null
}

// createPoll is lazy until subscribed. Two kinds of consumers: the bar
// (stats_on_panel or a "stats" [[panel]] entry) needs stats around the
// clock; the quick settings power pane only while it is visible — its
// widget drives setActive, and a 1 Hz poll + nvidia-smi child no
// longer run 24/7 for a pane that is open a few seconds at a time
const barWantsStats =
    Config.quicksettings.statsOnPanel ||
    Config.panels.some(p => [...p.left, ...p.center, ...p.right].includes("stats"))

let stopPoll: (() => void) | null = null
let qsActive = false

function syncEngines() {
    const want = barWantsStats || qsActive
    gpuWanted = want
    if (want && !stopPoll) {
        stopPoll = poll.subscribe(() => {})
        if (hasNvidia) startGpuStream()
    }
    if (!want && stopPoll) {
        stopPoll()
        stopPoll = null
        gpuProc?.force_exit()
        gpuProc = null
    }
}

// the power pane's stats tiles are on screen (or left it)
export function setActive(on: boolean) {
    qsActive = on
    syncEngines()
}

if (barWantsStats) syncEngines()

export function formatRate(bytesPerSec: number): string {
    if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`
    if (bytesPerSec >= 1024) return `${Math.round(bytesPerSec / 1024)} KB/s`
    return `${bytesPerSec} B/s`
}

// seconds -> "3 d 2 h" / "5 h 12 min" / "12 min" (two units, coarser
// first — the pane tile doesn't need seconds)
export function formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400)
    const h = Math.floor((seconds % 86400) / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    if (d > 0) return `${d} d ${h} h`
    if (h > 0) return `${h} h ${m} min`
    return `${m} min`
}

// tear-down entry point, run from app.tsx on shutdown (lib/lifecycle)
registerDispose("sysstats", dispose)
