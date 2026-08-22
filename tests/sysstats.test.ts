import { test, eq } from "./framework"
import {
    formatGpuPool,
    formatGpuPressureDesc,
    gpuPressureLevel,
    formatGpuSub,
    formatRate,
    formatTopMem,
    formatUptime,
    parseDrmSize,
    parseFdinfoDrmMem,
    normalizePciId,
    parseNvidiaApps,
    parseNvidiaGpuLine,
    parsePciName,
    poolPct,
    shortGpuName,
    parsePsiAvg60,
    cpuPressureLevel,
    CPU_PRESSURE_WARN,
    CPU_PRESSURE_CRIT,
    parseProcStat,
    ramPressureLevel,
    sumDiskSectors,
} from "../src/lib/sysstats"

test("formatRate: bytes below 1 KiB stay in B/s", () => {
    eq(formatRate(0), "0 B/s")
    eq(formatRate(512), "512 B/s")
    eq(formatRate(1023), "1023 B/s")
})

test("formatRate: KiB range rounds to whole KB/s", () => {
    eq(formatRate(1024), "1 KB/s")
    eq(formatRate(1536), "2 KB/s")
    eq(formatRate(1024 * 1024 - 1), "1024 KB/s")
})

test("formatRate: MiB range keeps one decimal", () => {
    eq(formatRate(1024 * 1024), "1.0 MB/s")
    eq(formatRate(2.5 * 1024 * 1024), "2.5 MB/s")
})

test("formatUptime: two units, coarser first", () => {
    eq(formatUptime(0), "0 min")
    eq(formatUptime(59), "0 min")
    eq(formatUptime(12 * 60 + 30), "12 min")
    eq(formatUptime(5 * 3600 + 12 * 60), "5 h 12 min")
    eq(formatUptime(3 * 86400 + 2 * 3600 + 45 * 60), "3 d 2 h")
})

// /proc/diskstats: sectors read = field 6, written = field 10
test("sumDiskSectors: whole disks only, no partition double-count", () => {
    const text = [
        " 259 0 nvme0n1 100 0 1000 0 200 0 4000 0 0 0 0",
        " 259 1 nvme0n1p1 50 0 500 0 100 0 2000 0 0 0 0",
        " 259 2 nvme0n1p2 50 0 500 0 100 0 2000 0 0 0 0",
        "   8 0 sda 10 0 100 0 20 0 400 0 0 0 0",
        "   8 1 sda1 10 0 100 0 20 0 400 0 0 0 0",
        " 179 0 mmcblk0 5 0 50 0 10 0 200 0 0 0 0",
        " 179 1 mmcblk0p1 5 0 50 0 10 0 200 0 0 0 0",
        " 252 0 zram0 999 0 9999 0 999 0 9999 0 0 0 0",
        "   7 0 loop0 999 0 9999 0 999 0 9999 0 0 0 0",
        "",
    ].join("\n")
    const { rSec, wSec } = sumDiskSectors(text)
    eq(rSec, 1000 + 100 + 50)
    eq(wSec, 4000 + 400 + 200)
})

test("sumDiskSectors: empty and malformed input", () => {
    eq(sumDiskSectors(""), { rSec: 0, wSec: 0 })
    eq(sumDiskSectors(" 259 0 nvme0n1 100\n"), { rSec: 0, wSec: 0 })
})

// /proc/pressure/memory: the warning keys on the "some" line's avg60
test("parsePsiAvg60: reads avg60 off the some line", () => {
    const text = [
        "some avg10=1.50 avg60=0.75 avg300=0.21 total=186644715",
        "full avg10=1.20 avg60=0.60 avg300=0.18 total=184899489",
        "",
    ].join("\n")
    eq(parsePsiAvg60(text), 0.75)
})

test("parsePsiAvg60: no some line, or garbage, is null", () => {
    eq(parsePsiAvg60("full avg10=0.00 avg60=0.05 avg300=0.21 total=1\n"), null)
    eq(parsePsiAvg60(""), null)
    eq(parsePsiAvg60("some\n"), null)
})

// /proc/<pid>/stat: comm can hold spaces and parens, rss is field 24
// (index 21 after the closing paren), in 4 KiB pages
test("parseProcStat: comm with spaces and parens, rss in bytes", () => {
    const stat = "1234 (my (weird) proc) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 256 0"
    eq(parseProcStat(stat), ["my (weird) proc", 256 * 4096])
})

test("parseProcStat: garbage is null", () => {
    eq(parseProcStat(""), null)
    eq(parseProcStat("1234 bash"), null)
    eq(parseProcStat("1234 (bash) S not-a-number"), null)
})

test("formatTopMem: biggest first, top n, long names truncated", () => {
    const procs: [string, number][] = [
        ["brave", 1024 * 1024 * 1024],
        ["qemu-system-x86_64", 6 * 1024 * 1024 * 1024],
        ["electron", 700 * 1024 * 1024],
        ["tiny", 1],
    ]
    eq(formatTopMem(procs), "qemu-system-x86… 6.0 GB · brave 1.0 GB · electron 700.0 MB")
    eq(formatTopMem(procs, 2), "qemu-system-x86… 6.0 GB · brave 1.0 GB")
    eq(formatTopMem([]), "")
})

// the drm-total/shared/resident family carries a per-line unit and
// drops it entirely on zero; the legacy drm-memory-* keys are all KiB
test("parseDrmSize: unit suffixes, in KiB", () => {
    eq(parseDrmSize("0"), 0)
    eq(parseDrmSize("12 KiB"), 12)
    eq(parseDrmSize("2 MiB"), 2048)
    eq(parseDrmSize("1 GiB"), 1024 * 1024)
    eq(parseDrmSize("  286604 KiB  "), 286604)
})

test("parseDrmSize: garbage is zero, not NaN", () => {
    eq(parseDrmSize(""), 0)
    eq(parseDrmSize("[N/A]"), 0)
    eq(parseDrmSize("12 TiB"), 0)
})

// resident MINUS shared: a buffer mapped by two clients is counted in
// full by both, so the plain total blames each for the other's memory
test("parseFdinfoDrmMem: subtracts shared from resident", () => {
    const text = [
        "drm-pdev:\t0000:65:00.0",
        "drm-total-vram:\t286604 KiB",
        "drm-shared-vram:\t19808 KiB",
        "drm-resident-vram:\t286604 KiB",
        "drm-total-gtt:\t2 MiB",
        "drm-shared-gtt:\t0",
        "drm-resident-gtt:\t2 MiB",
        "drm-memory-vram:\t286604 KiB",
        "",
    ].join("\n")
    // 286604 - 19808 held alone; GTT reported in MiB, returned as KiB
    eq(parseFdinfoDrmMem(text), { vram: 266796, gtt: 2048, pdev: "0000:65:00.0" })
})

test("parseFdinfoDrmMem: shared exceeding resident clamps at zero", () => {
    const text = ["drm-resident-vram:\t10 KiB", "drm-shared-vram:\t40 KiB", ""].join("\n")
    eq(parseFdinfoDrmMem(text)?.vram, 0)
})

test("parseFdinfoDrmMem: resident wins over the legacy key when both exist", () => {
    const text = [
        "drm-resident-vram:\t100 KiB",
        "drm-shared-vram:\t40 KiB",
        "drm-memory-vram:\t100 KiB",
        "",
    ].join("\n")
    eq(parseFdinfoDrmMem(text)?.vram, 60)
})

// drivers with no resident/shared breakdown keep the old behaviour
// rather than reporting nothing
test("parseFdinfoDrmMem: falls back to drm-memory-* when resident is absent", () => {
    const text = [
        "pos:\t0",
        "flags:\t02100002",
        "mnt_id:\t29",
        "drm-driver:\tamdgpu",
        "drm-client-id:\t7",
        "drm-pdev:\t0000:00:00.0",
        "drm-memory-vram:\t\t12345 KiB",
        "drm-memory-gtt:\t\t6789 KiB",
        "drm-memory-cpu:\t\t100 KiB",
        "drm-memory-vram:\t\t55 KiB",
        "",
    ].join("\n")
    eq(parseFdinfoDrmMem(text), { vram: 12400, gtt: 6789, pdev: "0000:00:00.0" })
})

test("parseFdinfoDrmMem: no drm-memory lines, or garbage, is null", () => {
    eq(parseFdinfoDrmMem(""), null)
    eq(parseFdinfoDrmMem("pos:\t0\nflags:\t02100002\n"), null)
    eq(parseFdinfoDrmMem("drm-memory-vram:\n"), null)
})

// a GPU tile's sub line. null/0 is "sensor not exposed" for both
// halves: a card can publish gpu_busy_percent with no hwmon node at
// all, and nvidia-smi reports [N/A] for fields it will not answer
test("formatGpuSub: both sensors, interpunct-joined", () => {
    eq(formatGpuSub(52, 1345), "52\u00b0C \u00b7 1345 MHz")
})

test("formatGpuSub: either half alone when the other is missing", () => {
    eq(formatGpuSub(52, null), "52\u00b0C")
    eq(formatGpuSub(null, 1345), "1345 MHz")
    eq(formatGpuSub(52, 0), "52\u00b0C")
})

test("formatGpuSub: neither sensor is an empty sub, not a stray separator", () => {
    eq(formatGpuSub(null, null), "")
    eq(formatGpuSub(0, 0), "")
})

// nvidia-smi pads the PCI domain to 8 hex digits, sysfs uses 4; the two
// have to compare equal or per-card attribution silently matches nothing
test("normalizePciId: nvidia and sysfs spellings converge", () => {
    eq(normalizePciId("00000000:64:00.0"), "0000:64:00.0")
    eq(normalizePciId("0000:65:00.0"), "0000:65:00.0")
    eq(normalizePciId("0000:65:00.0 "), "0000:65:00.0")
    eq(normalizePciId("00000000:64:00.0".toUpperCase()), "0000:64:00.0")
})

// hwdata pci.ids: vendors at column 0, their devices tab-indented under
test("parsePciName: prefers the bracketed marketing name", () => {
    const db = [
        "# comment",
        "1002  Advanced Micro Devices, Inc. [AMD/ATI]",
        "\t150e  Strix [Radeon 880M / 890M]",
        "\t1234  Some Plain Name",
        "10de  NVIDIA Corporation",
        "\t2820  AD106M [GeForce RTX 4070 Max-Q]",
        "",
    ].join("\n")
    eq(parsePciName(db, "1002", "150e"), "Radeon 880M / 890M")
    eq(parsePciName(db, "1002", "1234"), "Some Plain Name")
    eq(parsePciName(db, "10de", "2820"), "GeForce RTX 4070 Max-Q")
})

test("parsePciName: a device id from ANOTHER vendor's section is not a hit", () => {
    const db = ["1002  AMD", "\t150e  Strix [Radeon 890M]", "10de  NVIDIA", ""].join("\n")
    // 150e belongs to 1002, so asking 10de for it must miss
    eq(parsePciName(db, "10de", "150e"), "")
    eq(parsePciName(db, "9999", "150e"), "")
    eq(parsePciName("", "1002", "150e"), "")
})

test("shortGpuName: drops the vendor prefix and the trailing GPU", () => {
    eq(shortGpuName("NVIDIA GeForce RTX 4070 Laptop GPU"), "GeForce RTX 4070 Laptop")
    eq(shortGpuName("Radeon 890M"), "Radeon 890M")
})

// one --query-gpu row. The NAME may contain commas, so the row is split
// from both ends rather than positionally
test("parseNvidiaGpuLine: full row", () => {
    eq(
        parseNvidiaGpuLine(
            "0, NVIDIA GeForce RTX 4070 Laptop GPU, 00000000:64:00.0, 43, 44, 7404, 8188, 9.55, 210",
        ),
        {
            index: "0",
            name: "NVIDIA GeForce RTX 4070 Laptop GPU",
            pdev: "0000:64:00.0",
            busy: 43,
            temp: 44,
            vram: [7404, 8188],
            watts: 9.55,
            clock: 210,
        },
    )
})

test("parseNvidiaGpuLine: a comma in the model name survives", () => {
    const r = parseNvidiaGpuLine("1, Weird, Named GPU, 00000000:01:00.0, 1, 2, 3, 4, 5, 6")
    eq(r?.name, "Weird, Named GPU")
    eq(r?.index, "1")
    eq(r?.clock, 6)
})

test("parseNvidiaGpuLine: [N/A] fields are null, not zero", () => {
    const r = parseNvidiaGpuLine("0, GPU, 00000000:01:00.0, [N/A], 44, 7404, 8188, [N/A], 210")
    eq(r?.busy, null)
    eq(r?.watts, null)
    eq(r?.temp, 44)
})

test("parseNvidiaGpuLine: garbage and short rows are null", () => {
    eq(parseNvidiaGpuLine(""), null)
    eq(parseNvidiaGpuLine("0, GPU, 1, 2"), null)
    eq(parseNvidiaGpuLine("notanindex, GPU, 00000000:01:00.0, 1, 2, 3, 4, 5, 6"), null)
})

// nvidia-smi --query-compute-apps=gpu_bus_id,process_name,used_memory.
// The fdinfo walk cannot see nvidia VRAM at all, so this is the only
// per-process source for that card — and it must be filtered to the
// card being warned about
test("parseNvidiaApps: basenames the path, MiB -> bytes, filtered by card", () => {
    const text = [
        "00000000:64:00.0, /usr/lib/firefox/firefox, 7086",
        "00000000:01:00.0, /usr/bin/other, 512",
        "",
    ].join("\n")
    eq(parseNvidiaApps(text, "0000:64:00.0"), [["firefox", 7086 * 1024 * 1024]])
    eq(parseNvidiaApps(text, "0000:01:00.0"), [["other", 512 * 1024 * 1024]])
})

test("parseNvidiaApps: a path containing a comma splits on the LAST one", () => {
    eq(parseNvidiaApps("00000000:01:00.0, /opt/we,ird/app, 64\n", "0000:01:00.0"), [
        ["app", 64 * 1024 * 1024],
    ])
})

test("parseNvidiaApps: [N/A], zero and garbage are dropped", () => {
    eq(parseNvidiaApps("00000000:01:00.0, /usr/bin/x, [N/A]\n", "0000:01:00.0"), [])
    eq(parseNvidiaApps("00000000:01:00.0, /usr/bin/x, 0\n", "0000:01:00.0"), [])
    eq(parseNvidiaApps("", "0000:01:00.0"), [])
    eq(parseNvidiaApps("no comma here 123\n", "0000:01:00.0"), [])
})

// the pressure warning's detail line, now ONE card's. The bug this
// replaces: the level was max(all cards) while the text always printed
// whichever card owned a sysfs node, so a saturated dGPU showed the
// iGPU's calm numbers — and with two cards over, only one was named
const gpu = (
    name: string,
    vendor: "amd" | "nvidia",
    vram: [number, number],
    gtt: [number, number] | null,
) => ({
    id: `x:${name}`,
    name,
    vendor,
    pdev: "0000:00:00.0",
    busy: 9,
    temp: 9,
    clock: 9,
    watts: 9,
    vram,
    gtt,
})

const HOT_NV = gpu("RTX 4070", "nvidia", [7900, 8188], null)
const HOT_AMD = gpu("Radeon 890M", "amd", [7900, 8192], [10500, 11814])
const CALM_AMD = gpu("Radeon 890M", "amd", [1611, 8192], [144, 11814])

test("formatGpuPressureDesc: names the card when there is a second to confuse it with", () => {
    eq(formatGpuPressureDesc(HOT_NV, true), "RTX 4070 VRAM 7900/8188 MiB")
    eq(formatGpuPressureDesc(HOT_NV, false), "VRAM 7900/8188 MiB")
})

test("formatGpuPressureDesc: one card over on both pools is named once", () => {
    eq(
        formatGpuPressureDesc(HOT_AMD, true),
        "Radeon 890M VRAM 7900/8192 MiB \u00b7 GTT 10500/11814 MiB",
    )
})

test("formatGpuPressureDesc: a calm GTT is not listed beside a hot VRAM", () => {
    // the 1%-full GTT is what made the old warning read as a false alarm
    const g = gpu("Radeon 890M", "amd", [7900, 8192], [144, 11814])
    eq(formatGpuPressureDesc(g, true), "Radeon 890M VRAM 7900/8192 MiB")
})

test("formatGpuPressureDesc: GTT alone when GTT is the only pool over", () => {
    const g = gpu("Radeon 890M", "amd", [1611, 8192], [11400, 11814])
    eq(formatGpuPressureDesc(g, true), "Radeon 890M GTT 11400/11814 MiB")
})

test("formatGpuPressureDesc: a calm card has no line at all", () => {
    eq(formatGpuPressureDesc(CALM_AMD, true), "")
})

// each card carries its OWN severity: one critical card must not paint
// a merely-high one red, and vice versa
test("gpuPressureLevel: from the worse of the card's two pools", () => {
    eq(gpuPressureLevel(CALM_AMD), "")
    eq(gpuPressureLevel(HOT_NV), "critical")
    eq(gpuPressureLevel(gpu("a", "nvidia", [7100, 8188], null)), "warn")
})

test("gpuPressureLevel: GTT alone can raise the level", () => {
    eq(gpuPressureLevel(gpu("a", "amd", [100, 8192], [11400, 11814])), "critical")
    eq(gpuPressureLevel(gpu("a", "amd", [100, 8192], [10300, 11814])), "warn")
})

test("gpuPressureLevel: thresholds are exact, not rounded into", () => {
    // 84.9% must not round up to the 85% warn threshold
    eq(gpuPressureLevel(gpu("a", "nvidia", [8490, 10000], null)), "")
    eq(gpuPressureLevel(gpu("a", "nvidia", [8500, 10000], null)), "warn")
    eq(gpuPressureLevel(gpu("a", "nvidia", [9490, 10000], null)), "warn")
    eq(gpuPressureLevel(gpu("a", "nvidia", [9500, 10000], null)), "critical")
})

test("gpuPressureLevel: a card reporting no memory at all is not over", () => {
    eq(gpuPressureLevel(gpu("a", "nvidia", [0, 0], null)), "")
})

// GB, not MiB, and not a cosmetic choice: measured at the pane's 440px
// the MiB spelling makes the tile 217px against a 208px per-column
// budget, which flips the whole homogeneous FlowBox to one column
test("formatGpuPool: MiB in, one-decimal GB out", () => {
    eq(formatGpuPool("VRAM", 7900, 8188), "VRAM 7.7/8.0 GB")
    eq(formatGpuPool("GTT", 10500, 11814), "GTT 10.3/11.5 GB")
    eq(formatGpuPool("VRAM", 0, 8192), "VRAM 0.0/8.0 GB")
})

test("poolPct: whole percent, and a zero total is not a divide by zero", () => {
    eq(poolPct(7900, 8188), 96)
    eq(poolPct(1611, 8192), 20)
    eq(poolPct(0, 0), 0)
    eq(poolPct(100, 0), 0)
})

// the panel graph recolors off this, so a wrong verdict is a red bar on
// an idle machine (or a green one on a machine about to be OOM-killed)
test("ramPressureLevel: PSI drives it when the kernel reports it", () => {
    eq(ramPressureLevel(0, 40), "")
    eq(ramPressureLevel(4.99, 40), "")
    eq(ramPressureLevel(5, 40), "warn")
    eq(ramPressureLevel(19.99, 40), "warn")
    eq(ramPressureLevel(20, 40), "critical")
})

test("ramPressureLevel: used% is the fallback on a psi=0 kernel", () => {
    eq(ramPressureLevel(null, 89), "")
    eq(ramPressureLevel(null, 90), "warn")
    eq(ramPressureLevel(null, 95), "warn")
    eq(ramPressureLevel(null, 96), "critical")
})

// PSI says nothing until something has ALREADY stalled: a box at 97%
// one allocation from the OOM killer has not stalled yet
test("ramPressureLevel: the worse of the two votes wins", () => {
    eq(ramPressureLevel(0, 97), "critical")
    eq(ramPressureLevel(25, 10), "critical")
    eq(ramPressureLevel(0, 91), "warn")
    eq(ramPressureLevel(6, 10), "warn")
})

// CPU flashes like RAM and GPU do, so the thresholds carry the whole
// weight of not crying wolf: a full-width build settles near 25%
test("cpuPressureLevel: the two thresholds, exactly", () => {
    eq(cpuPressureLevel(0), "")
    eq(cpuPressureLevel(CPU_PRESSURE_WARN - 0.01), "")
    eq(cpuPressureLevel(CPU_PRESSURE_WARN), "warn")
    eq(cpuPressureLevel(CPU_PRESSURE_CRIT - 0.01), "warn")
    eq(cpuPressureLevel(CPU_PRESSURE_CRIT), "critical")
    eq(cpuPressureLevel(100), "critical")
})

// the whole point of measuring before picking numbers: -j24 must never
// colour the panel, let alone flash it
test("cpuPressureLevel: a full-width build stays clear of both lines", () => {
    eq(cpuPressureLevel(0.3), "") // idle
    eq(cpuPressureLevel(25), "") // -j24, settled
    eq(cpuPressureLevel(40), "") // -j24 with headroom to spare
})

test("cpuPressureLevel: a psi=0 kernel reports nothing rather than fine", () => {
    eq(cpuPressureLevel(null), "")
})
