import { test, eq } from "./framework"
import { formatRate, formatUptime, sumDiskSectors } from "../src/lib/sysstats"

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
