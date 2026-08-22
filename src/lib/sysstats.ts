import { createState } from "gnim"
import { createPoll } from "ags/time"
import { readFile, readFileAsync } from "ags/file"
import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { execAsync, timeoutAdd, sourceRemove } from "./metrics"
import { sumNetDev, formatBytes } from "./netTotals"
import Config from "../config"
import { streamLines } from "./streamLines"
import { registerDispose } from "./lifecycle"
import { createScrollCycler } from "./scrollCycle"

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

// ── GPUs ─────────────────────────────────────────────────────────────
//
// Every GPU the machine exposes, as ONE list. amdgpu cards come from
// sysfs (an entry per DRM card), nvidia GPUs from the nvidia-smi stream
// (an entry per index). Nothing here is merged across cards: they have
// separate sensors, separate memory pools and separate per-process
// accounting, and a hybrid box routinely sits with one saturated and
// the other idle. The pane pages between them.
export interface Gpu {
    /** stable identity, for keying the list and the selection:
     *  "amd:card0", "nv:0" — an index would shift as the nvidia stream
     *  appends entries a second after startup */
    id: string
    name: string
    vendor: "amd" | "nvidia"
    /** PCI slot, normalised "0000:65:00.0": the join key that attributes
     *  a process's memory back to a card (fdinfo drm-pdev on amdgpu,
     *  gpu_bus_id on nvidia) */
    pdev: string
    busy: number | null // %
    temp: number | null // °C
    clock: number | null // MHz, shader/graphics clock
    watts: number | null // W
    /** used,total MiB; [0,0] when the card does not report it */
    vram: [number, number]
    /** amdgpu only — nvidia has no GTT */
    gtt: [number, number] | null
}

export const [gpus, setGpus] = createState<Gpu[]>([])
// The identities alone, republished ONLY when a card appears, vanishes
// or is renamed. `gpus` carries live values, so it is a fresh array of
// fresh objects every tick — a <For> over that would tear down and
// rebuild the selector strip once a second
export const [gpuIds, setGpuIds] = createState<{ id: string; name: string }[]>([])
// the card the pane is showing, as its own state rather than something
// the widget derives: gnim's array-form createComputed caches on falsy
// checks, and both inputs here start falsy ([] and "") — the exact
// shape that has gone stale twice before (see AGENTS.md)
export const [activeGpu, setActiveGpu] = createState<Gpu | null>(null)

// There is no PSI for GPU memory, so "pressure" is a plain used/total
// percentage, unlike the PSI avg60 for RAM — a saturated carve-out is a
// compositor crash ("Not enough memory for command submission"), not
// sluggishness. Worst fill across every GPU, plus the card that owns
// it: the warning has to name the card it is warning about, and blame
// that card's processes rather than some other card's
export const [vramPressure, setVramPressure] = createState<number | null>(null)
export const [vramWorst, setVramWorst] = createState<Gpu | null>(null)
// amdgpu only — nvidia has no GTT
export const [gttPressure, setGttPressure] = createState<number | null>(null)
export const [gttWorst, setGttWorst] = createState<Gpu | null>(null)

/** one saturated card = one page of the pressure warning */
export interface GpuPressure {
    id: string
    name: string
    level: "warn" | "critical"
    /** the detail line: this card's over-threshold pools */
    desc: string
    /** this card's biggest consumers; "" when none are attributable */
    hogs: string
}

// EVERY card over the line, worst first — not just the single worst.
// Two saturated cards used to report as one: the warning kept a lone
// `vramWorst` and the second card was never mentioned. The pane pages
// through these the same way it pages through the GPU tiles, which is
// also what lets each page blame its OWN card's processes — a
// different card's process list is worse than none
export const [gpuPressures, setGpuPressures] = createState<GpuPressure[]>([])
// stable identities for the selector strip, republished only when the
// SET changes (see gpuIds for why)
export const [gpuPressureIds, setGpuPressureIds] = createState<{ id: string; name: string }[]>([])
export const [activePressure, setActivePressure] = createState<GpuPressure | null>(null)
export const [activePressureId, setActivePressureId] = createState("")
// whether ANY page has a consumer line: the label is shown or hidden
// for the whole carousel at once, so paging between a card with hogs
// and one without does not resize the card under the pointer
export const [gpuHogsShown, setGpuHogsShown] = createState(false)

// used/total percentages; identical for VRAM and GTT
export const VRAM_PRESSURE_WARN = 85
export const VRAM_PRESSURE_CRIT = 95
export const GTT_PRESSURE_WARN = 85
export const GTT_PRESSURE_CRIT = 95

// the biggest VRAM consumers ride GpuPressure.hogs, one line per
// saturated card — see gpuPressures

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

// Probed once at import (like hasPsi/hasNvidia): EVERY amdgpu card
// whose mem_info_vram_total is real, not just the first. The driver
// check skips i915 (it exposes these files only on discrete parts) and
// nvidia, whose stats come from the nvidia-smi stream instead.
interface AmdCard {
    id: string
    dev: string
    pdev: string
    /** upgraded from pci.ids on the first poll; see loadAmdNames */
    name: string
    vendorId: string
    deviceId: string
    busyPath: string | null
    tempPath: string | null
    clockPath: string | null
    wattsPath: string | null
}

// Everything below is probed with a REAL READ, not an EXISTS test (the
// RAPL note in powerDetails): amdgpu exposes several of these as stubs
// that open fine and then fail or return empty — mem_busy_percent is
// exactly that on Strix Point — and an unreadable file must hide its
// tile rather than pin it at 0.
const probeRead = (path: string): string => {
    try {
        return readFile(path).trim()
    } catch {
        return ""
    }
}

// hwmon sensor NUMBERING is not stable across amdgpu generations —
// discrete parts carry temp1=edge, temp2=junction, temp3=mem, and only
// some expose power1_average alongside power1_input. So a sensor is
// found by its *_label, with <kind>1 as the fallback for the older
// cards that publish no labels at all. `values` is tried in order, so
// the caller states its preference (averaged power over instantaneous).
function findAmdSensor(
    hwmon: string | null,
    kind: string,
    label: string,
    values: string[],
): string | null {
    if (!hwmon) return null
    const at = (i: number) =>
        values.map(v => `${hwmon}/${kind}${i}${v}`).find(f => probeRead(f) !== "")
    for (let i = 1; i <= 8; i++) {
        if (probeRead(`${hwmon}/${kind}${i}_label`) !== label) continue
        const f = at(i)
        if (f) return f
    }
    return at(1) ?? null
}

// the card's own hwmon node, where temperature, clock and power live
// (gpu_busy_percent sits in the device dir instead)
function findAmdHwmon(dev: string): string | null {
    try {
        const base = `${dev}/hwmon`
        const d = GLib.Dir.open(base, 0)
        let name: string | null
        while ((name = d.read_name()) !== null) {
            if (name.startsWith("hwmon")) {
                d.close()
                return `${base}/${name}`
            }
        }
        d.close()
    } catch {
        // no hwmon node on this card
    }
    return null
}

// pure helper, exported for tests: PCI ids come 8-hex-padded from
// nvidia-smi ("00000000:64:00.0") and 4-hex from sysfs
// ("0000:64:00.0"); one spelling so the two can be compared
export function normalizePciId(id: string): string {
    const t = id.trim().toLowerCase()
    const i = t.indexOf(":")
    if (i < 0) return t
    return t.slice(Math.max(0, i - 4), i).padStart(4, "0") + t.slice(i)
}

const amdCards: AmdCard[] = (() => {
    const cards: AmdCard[] = []
    let en: Gio.FileEnumerator | null = null
    try {
        en = Gio.File.new_for_path("/sys/class/drm").enumerate_children(
            "standard::name",
            Gio.FileQueryInfoFlags.NONE,
            null,
        )
        let info: Gio.FileInfo | null
        while ((info = en.next_file(null)) !== null) {
            const card = info.get_name()
            if (!/^card\d+$/.test(card)) continue
            const dev = `/sys/class/drm/${card}/device`
            let driver = ""
            try {
                driver = GLib.file_read_link(`${dev}/driver`)
            } catch {
                continue // no bound driver (yet)
            }
            if (!driver.endsWith("/amdgpu")) continue
            if (Number(probeRead(`${dev}/mem_info_vram_total`)) <= 0) continue
            const hwmon = findAmdHwmon(dev)
            cards.push({
                id: `amd:${card}`,
                dev,
                pdev: normalizePciId(
                    probeRead(`${dev}/uevent`).match(/PCI_SLOT_NAME=(\S+)/)?.[1] ?? "",
                ),
                name: "AMD GPU",
                vendorId: probeRead(`${dev}/vendor`).replace(/^0x/, ""),
                deviceId: probeRead(`${dev}/device`).replace(/^0x/, ""),
                busyPath:
                    probeRead(`${dev}/gpu_busy_percent`) !== "" ? `${dev}/gpu_busy_percent` : null,
                tempPath: findAmdSensor(hwmon, "temp", "edge", ["_input"]),
                clockPath: findAmdSensor(hwmon, "freq", "sclk", ["_input"]),
                // power1_average is the rolling average the SMU
                // publishes, power1_input the instantaneous sample.
                // Prefer the average: a 1 Hz tile built from
                // instantaneous samples is unreadable noise
                wattsPath: findAmdSensor(hwmon, "power", "PPT", ["_average", "_input"]),
            })
        }
    } catch {
        // no drm class at all (or unreadable): no amdgpu stats
    } finally {
        en?.close(null)
    }
    // card0, card1, … so the list order does not depend on readdir
    return cards.sort((a, b) => a.id.localeCompare(b.id))
})()

// disambiguate identical cards (two of the same model) by DRM node
if (amdCards.length > 1) for (const c of amdCards) c.name = `AMD GPU (${c.id.slice(4)})`

// null on an unreadable/absent sensor, so a failed read keeps the last
// good value instead of blinking the tile to 0
function sensorNum(text: string): number | null {
    const n = Number(text.trim())
    return text.trim() === "" || isNaN(n) ? null : n
}

// pure parser, exported for tests: a human name out of hwdata's
// pci.ids. NEVER splits the file — it is ~1.6 MB, and a 30 000-element
// array on the main loop is a visible hitch where two indexOf scans in
// C are not. Vendor sections start at column 0, their devices are
// tab-indented beneath them, so a device hit only counts while it is
// still inside the requested vendor's section.
export function parsePciName(db: string, vendor: string, device: string): string {
    const head = `${vendor}  `
    const v = db.startsWith(head) ? 0 : db.indexOf(`\n${head}`) + 1
    if (v === 0 && !db.startsWith(head)) return ""
    const d = db.indexOf(`\n\t${device}  `, v)
    if (d < 0) return ""
    // the next column-0 line ends this vendor's section
    const re = /\n[^\t#\n]/g
    re.lastIndex = v
    const m = re.exec(db)
    if (m && d > m.index) return ""
    const nl = db.indexOf("\n", d + 1)
    const line = db.slice(d + 1, nl < 0 ? undefined : nl).trim()
    const name = line.replace(/^\S+\s+/, "")
    // pci.ids pairs a codename with the marketing name in brackets
    // ("Strix [Radeon 880M / 890M]") — the bracket is the half a person
    // actually recognises
    return name.match(/\[([^\]]+)\]/)?.[1] ?? name
}

// pure formatter, exported for tests: nvidia-smi's names are already
// human ("NVIDIA GeForce RTX 4070 Laptop GPU") but too wide for an
// eyebrow; the vendor is obvious from the model, the "GPU" is noise
export function shortGpuName(name: string): string {
    return name
        .replace(/^NVIDIA\s+/i, "")
        .replace(/\s+GPU$/i, "")
        .trim()
}

// pure helper, exported for tests: one fdinfo size, in KiB. The legacy
// drm-memory-* keys are always KiB, but the drm-total/shared/resident
// family carries its own unit per line — and drops it entirely on zero
// ("0", "12 KiB", "2 MiB")
export function parseDrmSize(value: string): number {
    const m = value.trim().match(/^(\d+)(?:\s*(KiB|MiB|GiB))?$/)
    if (!m) return 0
    const n = Number(m[1])
    if (m[2] === "MiB") return n * 1024
    if (m[2] === "GiB") return n * 1024 * 1024
    return n // KiB, or a bare 0
}

// pure parser, exported for tests: one fdinfo file's VRAM/GTT
// attribution, in KiB, plus the card it belongs to.
//
// RESIDENT MINUS SHARED, not the legacy drm-memory-* total: a buffer
// mapped by two clients is counted in full by both, so summing totals
// blames every client for its neighbours' memory. A compositor and its
// clients share scanout buffers constantly, which is how the old line
// managed to blame small clients for ~90 MiB apiece that they did not
// own and that killing them would not have freed. Subtracting `shared`
// leaves what a client alone holds resident — which is the question the
// warning is actually asking.
//
// This shrinks the overcount but does NOT end it: per-client fdinfo
// views cannot be summed into device usage (measured on a hybrid box,
// 3.2x over ground truth becomes 2.4x). The ordering is what this line
// is for. Drivers that publish no resident/shared breakdown fall back
// to the legacy key.
export function parseFdinfoDrmMem(
    text: string,
): { vram: number; gtt: number; pdev: string } | null {
    let pdev = "",
        haveResident = false,
        haveLegacy = false
    const resident = { vram: 0, gtt: 0 }
    const shared = { vram: 0, gtt: 0 }
    const legacy = { vram: 0, gtt: 0 }
    for (const line of text.split("\n")) {
        // which CARD this fd belongs to: with two amdgpu cards the
        // totals would otherwise be summed across both
        const d = line.match(/^drm-pdev:\s*(\S+)/)
        if (d) {
            pdev = normalizePciId(d[1])
            continue
        }
        const m = line.match(/^drm-(resident|shared|memory)-(vram|gtt):\s*(.+)$/)
        if (!m) continue
        const region = m[2] as "vram" | "gtt"
        const size = parseDrmSize(m[3])
        if (m[1] === "resident") {
            resident[region] += size
            haveResident = true
        } else if (m[1] === "shared") {
            shared[region] += size
        } else {
            legacy[region] += size
            haveLegacy = true
        }
    }
    if (!haveResident && !haveLegacy) return null
    const pick = (r: "vram" | "gtt") =>
        haveResident ? Math.max(0, resident[r] - shared[r]) : legacy[r]
    return { vram: pick("vram"), gtt: pick("gtt"), pdev }
}

// /proc/<pid>/fdinfo walk for the biggest VRAM consumers, as
// [comm, bytes] pairs for formatTopMem. Sync reads of kernel-generated
// tiny files, only ever run while the warning can be on screen — same
// justification as scanTopMem. VRAM only: that is what saturates the
// carve-out; comm from /proc/<pid>/stat via parseProcStat. Scoped to
// ONE card's pdev, and to memory each client holds on its own — see
// parseFdinfoDrmMem for why the totals still run over device usage and
// why the ORDERING is what this line exists to give
function scanGpuMemHogs(pdevs: string[]): Map<string, [string, number][]> {
    // ONE walk for every card being warned about: the walk is the
    // expensive part, splitting the results by card is bookkeeping
    const out = new Map<string, [string, number][]>()
    for (const d of pdevs) out.set(d, [])
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
            // a pid can exit mid-scan: anything unreadable is skipped
            const byPdev = new Map<string, number>()
            try {
                const fen = Gio.File.new_for_path(`/proc/${pid}/fdinfo`).enumerate_children(
                    "standard::name",
                    Gio.FileQueryInfoFlags.NONE,
                    null,
                )
                try {
                    let fi: Gio.FileInfo | null
                    while ((fi = fen.next_file(null)) !== null) {
                        const [ok, data] = GLib.file_get_contents(
                            `/proc/${pid}/fdinfo/${fi.get_name()}`,
                        )
                        if (!ok) continue
                        const m = parseFdinfoDrmMem(new TextDecoder().decode(data))
                        if (!m || m.vram <= 0) continue
                        // a blank pdev is a kernel too old to publish
                        // it: attribute to every card being warned
                        // about rather than naming nobody
                        for (const d of m.pdev === "" ? pdevs : [m.pdev]) {
                            if (!out.has(d)) continue
                            byPdev.set(d, (byPdev.get(d) ?? 0) + m.vram)
                        }
                    }
                } finally {
                    fen.close(null)
                }
            } catch {
                continue
            }
            if (byPdev.size === 0) continue
            const [ok, data] = GLib.file_get_contents(`/proc/${pid}/stat`)
            if (!ok) continue
            const p = parseProcStat(new TextDecoder().decode(data))
            if (!p) continue
            for (const [d, kib] of byPdev) out.get(d)?.push([p[0], kib * 1024])
        }
    } finally {
        en?.close(null)
    }
    return out
}

// nvidia's per-process VRAM. The fdinfo walk above CANNOT see it: only
// DRM-native drivers publish drm-memory-* there, and the proprietary
// nvidia module publishes nothing at all — pointed at a hybrid box it
// happily returns the amdgpu clients, i.e. the wrong card's process
// list beside the wrong card's numbers.
//
// KNOWN GAP: nvidia-smi exposes no --query-graphics-apps, only
// --query-compute-apps, so a client holding VRAM through a
// graphics-only context (a game, the compositor) is not listed. Compute
// contexts are what actually balloon, and an incomplete right answer
// beats a complete wrong one — the previous behaviour was the latter.
const NVIDIA_HOGS_CMD = [
    "nvidia-smi",
    "--query-compute-apps=gpu_bus_id,process_name,used_memory",
    "--format=csv,noheader,nounits",
]

// pure parser, exported for tests: "/usr/lib/firefox/firefox, 7086"
// lines -> [comm, bytes] pairs for formatTopMem. The name is a full
// path; basename it to match the /proc comm the amdgpu side produces.
// used_memory reads "[N/A]" on GPUs that will not report it — those
// lines simply do not match and are dropped
export function parseNvidiaApps(text: string, pdev: string): [string, number][] {
    const out: [string, number][] = []
    for (const line of text.split("\n")) {
        // bus id first, memory last, everything between is the path —
        // which may itself contain commas
        const m = line.match(/^([^,]+),\s*(.*),\s*(\d+)\s*$/)
        if (!m) continue
        if (normalizePciId(m[1]) !== pdev) continue
        const name = m[2].trim().split("/").pop() ?? ""
        const mib = Number(m[3])
        if (name && mib > 0) out.push([name, mib * 1024 * 1024])
    }
    return out
}

// one spawn covers every nvidia GPU; parseNvidiaApps filters the same
// output per card
async function readNvidiaApps(): Promise<string> {
    return execAsync(NVIDIA_HOGS_CMD)
}

// Live per-card readings, keyed by Gpu.id. Two independent writers —
// the amdgpu poll step and the nvidia stream — so neither may rebuild
// the published array from its own half alone; both write here and call
// publishGpus.
const gpuState = new Map<string, Gpu>()
// list order: amdgpu cards (known at import) first, then nvidia indices
// in the order the stream first reports them. Selection is keyed on id
// precisely because this list GROWS a second after startup
const gpuOrder: string[] = amdCards.map(c => c.id)

for (const c of amdCards)
    gpuState.set(c.id, {
        id: c.id,
        name: c.name,
        vendor: "amd",
        pdev: c.pdev,
        busy: null,
        temp: null,
        clock: null,
        watts: null,
        vram: [0, 0],
        gtt: null,
    })

// worst fill across every card, and which card owns it

// The card everything single-GPU speaks for: the discrete one. On a
// hybrid box that is the nvidia GPU the bar has always shown, so the
// panel keeps its behaviour; on an AMD-only box it is a GPU readout the
// bar never used to get at all
function primaryGpu(list: Gpu[]): Gpu | undefined {
    return list.find(g => g.vendor === "nvidia") ?? list[0]
}

// exact fill, unrounded: poolPct rounds for display, and a card at
// 84.6% must not be pushed over an 85% threshold by the rounding
const fill = (used: number, total: number) => (total > 0 ? (100 * used) / total : 0)

// pure helper, exported for tests: one card's own severity, from the
// worse of its two pools. "" when the card is fine
export function gpuPressureLevel(g: Gpu): "" | "warn" | "critical" {
    const v = fill(g.vram[0], g.vram[1])
    const t = g.gtt ? fill(g.gtt[0], g.gtt[1]) : 0
    if (v >= VRAM_PRESSURE_CRIT || t >= GTT_PRESSURE_CRIT) return "critical"
    if (v >= VRAM_PRESSURE_WARN || t >= GTT_PRESSURE_WARN) return "warn"
    return ""
}

// pure formatter, exported for tests: ONE card's detail line. Lists a
// pool only when that pool is itself over — a 1%-full GTT printed
// beside a saturated VRAM reads as "nothing is wrong here" — and names
// the card only when the machine has a second one to confuse it with
export function formatGpuPressureDesc(g: Gpu, tagged: boolean): string {
    const parts: string[] = []
    const tag = tagged ? `${g.name} ` : ""
    if (fill(g.vram[0], g.vram[1]) >= VRAM_PRESSURE_WARN)
        parts.push(`${tag}VRAM ${g.vram[0]}/${g.vram[1]} MiB`)
    if (g.gtt && fill(g.gtt[0], g.gtt[1]) >= GTT_PRESSURE_WARN)
        // the card is named once per line, not once per pool
        parts.push(`${parts.length > 0 ? "" : tag}GTT ${g.gtt[0]}/${g.gtt[1]} MiB`)
    return parts.join(" · ")
}

// hogs are filled in by the gpuMemHogs step a tick later; keyed by
// Gpu.id so a rebuild here does not drop them
const hogsById = new Map<string, string>()

function updatePressure(list: Gpu[]) {
    // the maxima still gate the hog scan and the bar's severity
    let vp: number | null = null,
        vw: Gpu | null = null,
        gp: number | null = null,
        gw: Gpu | null = null
    for (const g of list) {
        if (g.vram[1] > 0) {
            const f = fill(g.vram[0], g.vram[1])
            if (vp === null || f > vp) [vp, vw] = [f, g]
        }
        if (g.gtt && g.gtt[1] > 0) {
            const f = fill(g.gtt[0], g.gtt[1])
            if (gp === null || f > gp) [gp, gw] = [f, g]
        }
    }
    setVramPressure(vp)
    setVramWorst(vw)
    setGttPressure(gp)
    setGttWorst(gw)

    // one page per card that is actually over, worst first so the
    // carousel opens on the one closest to failing
    const tagged = list.length > 1
    const pages: GpuPressure[] = list
        .map(g => ({ g, level: gpuPressureLevel(g) }))
        .filter((x): x is { g: Gpu; level: "warn" | "critical" } => x.level !== "")
        .sort(
            (a, b) =>
                Math.max(
                    fill(b.g.vram[0], b.g.vram[1]),
                    b.g.gtt ? fill(b.g.gtt[0], b.g.gtt[1]) : 0,
                ) -
                Math.max(
                    fill(a.g.vram[0], a.g.vram[1]),
                    a.g.gtt ? fill(a.g.gtt[0], a.g.gtt[1]) : 0,
                ),
        )
        .map(({ g, level }) => ({
            id: g.id,
            name: g.name,
            level,
            desc: formatGpuPressureDesc(g, tagged),
            hogs: hogsById.get(g.id) ?? "",
        }))
    setGpuPressures(pages)
    setGpuHogsShown(pages.some(p => p.hogs !== ""))
    const key = pages.map(p => `${p.id}\u0000${p.name}`).join("\u0001")
    if (key !== lastPressureKey) {
        lastPressureKey = key
        setGpuPressureIds(pages.map(p => ({ id: p.id, name: p.name })))
    }
    pickPressure()
}

let lastIdsKey = ""
let lastPressureKey = ""
let pressureOverride: string | null = null

function pickPressure() {
    const pages = gpuPressures.get()
    const show = (id: string) => {
        setActivePressureId(id)
        setActivePressure(pages.find(p => p.id === id) ?? null)
    }
    // an override only survives while that card is still in trouble;
    // once it recovers the carousel falls back to the worst remaining
    if (pressureOverride && pages.some(p => p.id === pressureOverride)) {
        show(pressureOverride)
        return
    }
    show(pages[0]?.id ?? "")
}

/** jump to a card's page (clicking a segment in the warning's strip) */
export function selectPressure(id: string) {
    pressureOverride = id
    pickPressure()
}

/** page through the saturated cards; a no-op with fewer than two */
export function cycleActivePressure(direction: 1 | -1) {
    const pages = gpuPressures.get()
    if (pages.length < 2) return
    const i = pages.findIndex(p => p.id === activePressureId.get())
    selectPressure(pages[(i + direction + pages.length) % pages.length].id)
}

/** scroll anywhere on the warning to page through the saturated cards */
export const scrollActivePressure = createScrollCycler(cycleActivePressure)

function publishGpus() {
    const list = gpuOrder.map(id => gpuState.get(id)).filter((g): g is Gpu => g !== undefined)
    setGpus(list)
    const idsKey = list.map(g => `${g.id}\u0000${g.name}`).join("\u0001")
    if (idsKey !== lastIdsKey) {
        lastIdsKey = idsKey
        setGpuIds(list.map(g => ({ id: g.id, name: g.name })))
    }
    updatePressure(list)
    pickGpu()
    // widgets/bar/barModules/sysStats still reads these scalars
    const g = primaryGpu(list)
    setGpu(g?.busy ?? null)
    setGpuTemp(g?.temp ?? 0)
    setGpuWatts(g?.watts ?? 0)
    setVram(g?.vram ?? [0, 0])
}

// pure formatter, exported for tests: a GPU memory pool as
// "<label> used/total GB". MiB in, GB out, and deliberately: MEASURED
// at the pane's 440px, the MiB spelling makes the tile 217px wide
// against a 208px per-column budget, which flips the whole homogeneous
// FlowBox to one column (the trap in AGENTS.md). GB lands at 164px
export function formatGpuPool(label: string, usedMiB: number, totalMiB: number): string {
    return `${label} ${(usedMiB / 1024).toFixed(1)}/${(totalMiB / 1024).toFixed(1)} GB`
}

// pure helper, exported for tests: a pool's fill as a whole percent
export function poolPct(usedMiB: number, totalMiB: number): number {
    return totalMiB > 0 ? Math.round((100 * usedMiB) / totalMiB) : 0
}

// pure formatter, exported for tests: a GPU tile's sub line —
// "52°C · 1345 MHz", either half alone when the other sensor is not
// exposed, "" when neither is
export function formatGpuSub(tempC: number | null, clockMhz: number | null): string {
    const parts: string[] = []
    if (tempC !== null && tempC > 0) parts.push(`${tempC}°C`)
    if (clockMhz !== null && clockMhz > 0) parts.push(`${clockMhz} MHz`)
    return parts.join(" · ")
}

// ── which card the pane is showing ───────────────────────────────────
// Mirrors the media card's player switching (lib/mpris): an automatic
// pick until the user chooses, an explicit override after.
let gpuOverride: string | null = null
export const [activeGpuId, setActiveGpuId] = createState("")

function pickGpu() {
    const list = gpus.get()
    const show = (id: string) => {
        setActiveGpuId(id)
        setActiveGpu(list.find(g => g.id === id) ?? null)
    }
    if (gpuOverride && list.some(g => g.id === gpuOverride)) {
        show(gpuOverride)
        return
    }
    // nothing chosen yet: open on the DISCRETE card. On a hybrid laptop
    // the amdgpu entry is the iGPU and the nvidia one is the part
    // someone opening this pane is asking about. Free to move only
    // because no explicit choice has been made — which is also why the
    // nvidia entries arriving a second late do not yank the selection
    // out from under anyone
    show((list.find(g => g.vendor === "nvidia") ?? list[0])?.id ?? "")
}

/** jump to a card (clicking a segment in the pane's selector strip) */
export function selectGpu(id: string) {
    gpuOverride = id
    pickGpu()
}

/** page through the cards; a no-op with fewer than two */
export function cycleActiveGpu(direction: 1 | -1) {
    const list = gpus.get()
    if (list.length < 2) return
    const i = list.findIndex(g => g.id === activeGpuId.get())
    selectGpu(list[(i + direction + list.length) % list.length].id)
}

/** scroll anywhere on the GPU tiles to page through cards — same
 *  accumulate-and-debounce gesture as the media card's switcher */
export const scrollActiveGpu = createScrollCycler(cycleActiveGpu)

// hwdata's PCI database, read ONCE and off the startup path (first poll
// tick, i.e. first time anything actually wants GPU stats) to upgrade
// "AMD GPU" into the name on the box. Optional package: no file, no
// upgrade, and the fallback names still disambiguate the cards
const PCI_IDS = "/usr/share/hwdata/pci.ids"
let pciNamesDone = amdCards.length === 0
async function loadAmdNames() {
    if (pciNamesDone) return
    pciNamesDone = true
    if (!GLib.file_test(PCI_IDS, GLib.FileTest.EXISTS)) return
    const db = await readFileAsync(PCI_IDS)
    let hit = false
    for (const c of amdCards) {
        const name = parsePciName(db, c.vendorId, c.deviceId)
        if (!name) continue
        const g = gpuState.get(c.id)
        if (!g) continue
        // keep the DRM node on identical twins, or the selector shows
        // the same label twice
        gpuState.set(c.id, {
            ...g,
            name: amdCards.length > 1 ? `${name} (${c.id.slice(4)})` : name,
        })
        hit = true
    }
    if (hit) publishGpus()
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
    if (amdCards.length > 0) {
        step("gpuNames", loadAmdNames)
        step("amdGpu", async () => {
            for (const c of amdCards) {
                const g = gpuState.get(c.id)
                if (!g) continue
                const [vu, vt, gu, gt] = (
                    await Promise.all([
                        readFileAsync(`${c.dev}/mem_info_vram_used`),
                        readFileAsync(`${c.dev}/mem_info_vram_total`),
                        readFileAsync(`${c.dev}/mem_info_gtt_used`),
                        readFileAsync(`${c.dev}/mem_info_gtt_total`),
                    ])
                ).map(b => Math.round(Number(b) / 1024 / 1024))
                const read1 = async (f: string | null) =>
                    f ? sensorNum(await readFileAsync(f)) : null
                const [busy, temp, clock, watts] = await Promise.all([
                    read1(c.busyPath),
                    read1(c.tempPath),
                    read1(c.clockPath),
                    read1(c.wattsPath),
                ])
                gpuState.set(c.id, {
                    ...g,
                    // a failed read keeps the last good value rather
                    // than blinking the tile to zero
                    busy: busy !== null ? Math.round(busy) : g.busy,
                    temp: temp !== null ? Math.round(temp / 1000) : g.temp, // m°C
                    clock: clock !== null ? Math.round(clock / 1e6) : g.clock, // Hz
                    watts: watts !== null ? watts / 1e6 : g.watts, // µW
                    vram: [vu, vt],
                    gtt: [gu, gt],
                })
            }
            publishGpus()
            const p = primaryGpu(gpus.get())
            if (p?.vendor === "amd" && p.busy !== null) push(gpuHist.get(), setGpuHist, p.busy)
        })
    }
    // the "who to kill" lines, in a step of its own: one page per
    // saturated card, each blaming its OWN card's processes. Both scans
    // ride the pressure gate — neither ever runs unless the warning can
    // be on screen — and each runs ONCE for all cards, not once per card
    if (amdCards.length > 0 || hasNvidia)
        step("gpuMemHogs", async () => {
            // one tick stale by construction: the steps above are
            // siblings, not awaited, which only ever costs these lines
            // a second to catch up. The warning's own numbers come
            // straight from the states and are current
            const pages = gpuPressures.get()
            if (pages.length === 0) {
                if (hogsById.size > 0) {
                    hogsById.clear()
                    publishGpus()
                }
                return
            }
            const list = gpus.get()
            const targets = pages
                .map(p => list.find(g => g.id === p.id))
                .filter((g): g is Gpu => g !== undefined)
            const amd = targets.filter(g => g.vendor === "amd")
            const nv = targets.filter(g => g.vendor === "nvidia")
            const byPdev =
                amd.length > 0
                    ? scanGpuMemHogs(amd.map(g => g.pdev))
                    : new Map<string, [string, number][]>()
            const nvText = nv.length > 0 ? await readNvidiaApps() : ""
            hogsById.clear()
            for (const g of amd) hogsById.set(g.id, formatTopMem(byPdev.get(g.pdev) ?? []))
            for (const g of nv) hogsById.set(g.id, formatTopMem(parseNvidiaApps(nvText, g.pdev)))
            publishGpus()
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
// per-tick spawn was the shell's most frequent fork. One line per GPU
// per interval — `index` leads the row precisely because a multi-GPU
// box emits SEVERAL lines a tick, and keying on it is what stops the
// second card from overwriting the first
const GPU_CMD = [
    "nvidia-smi",
    "--query-gpu=index,name,pci.bus_id,utilization.gpu,temperature.gpu," +
        "memory.used,memory.total,power.draw,clocks.current.graphics",
    "--format=csv,noheader,nounits",
    `--loop-ms=${Math.max(1, Math.round(INTERVAL))}`,
]

// restart on death (driver reloads kill the stream), but cap attempts
// so a persistently failing nvidia-smi can't fork-loop. Any received
// line proves the driver is healthy, so it resets the budget.
const GPU_RESTART_DELAY = 5000
const GPU_MAX_RESTARTS = 5
let gpuRestarts = 0

// pure parser, exported for tests: one nvidia-smi row ->
// "index, name, bus id, util, temp, memUsed, memTotal, watts, clock".
// The NAME can contain commas, so the row is split from both ends: one
// field in front, six numbers behind, whatever is left is the name.
// Any field can read "[N/A]" during a driver transition — those become
// null rather than 0, which is a real reading
export function parseNvidiaGpuLine(line: string): {
    index: string
    name: string
    pdev: string
    busy: number | null
    temp: number | null
    vram: [number, number]
    watts: number | null
    clock: number | null
} | null {
    const f = line.split(",").map(v => v.trim())
    if (f.length < 9 || !/^\d+$/.test(f[0])) return null
    const num = (v: string): number | null => {
        const n = Number(v)
        return v === "" || isNaN(n) ? null : n
    }
    const [util, temp, used, total, watts, clock] = f.slice(-6).map(num)
    return {
        index: f[0],
        name: f.slice(1, f.length - 7).join(", "),
        pdev: normalizePciId(f[f.length - 7]),
        busy: util,
        temp,
        vram: [used ?? 0, total ?? 0],
        watts,
        clock,
    }
}

function handleGpuLine(line: string) {
    gpuRestarts = 0
    const r = parseNvidiaGpuLine(line)
    if (!r) return
    const id = `nv:${r.index}`
    const prev = gpuState.get(id)
    if (!prev) gpuOrder.push(id)
    gpuState.set(id, {
        id,
        name: shortGpuName(r.name),
        vendor: "nvidia",
        pdev: r.pdev,
        // "[N/A]" during driver transitions: keep the last good value
        // rather than blinking the tile to zero
        busy: r.busy ?? prev?.busy ?? null,
        temp: r.temp ?? prev?.temp ?? null,
        clock: r.clock ?? prev?.clock ?? null,
        watts: r.watts ?? prev?.watts ?? null,
        vram: r.vram[1] > 0 ? r.vram : (prev?.vram ?? [0, 0]),
        gtt: null, // nvidia has no GTT
    })
    publishGpus()
    // only the card the bar is showing feeds its graph — a hybrid box
    // publishes twice a tick and would otherwise double its rate
    if (r.busy !== null && primaryGpu(gpus.get())?.id === id)
        push(gpuHist.get(), setGpuHist, r.busy)
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
