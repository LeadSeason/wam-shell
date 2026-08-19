import { test, eq } from "./framework"
import {
    formatRate,
    formatTopMem,
    formatUptime,
    parseMemPressure,
    parseProcStat,
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
test("parseMemPressure: reads avg60 off the some line", () => {
    const text = [
        "some avg10=1.50 avg60=0.75 avg300=0.21 total=186644715",
        "full avg10=1.20 avg60=0.60 avg300=0.18 total=184899489",
        "",
    ].join("\n")
    eq(parseMemPressure(text), 0.75)
})

test("parseMemPressure: no some line, or garbage, is null", () => {
    eq(parseMemPressure("full avg10=0.00 avg60=0.05 avg300=0.21 total=1\n"), null)
    eq(parseMemPressure(""), null)
    eq(parseMemPressure("some\n"), null)
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
