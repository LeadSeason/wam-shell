import { test, eq } from "./framework"
import { formatRate } from "../src/lib/sysstats"

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
