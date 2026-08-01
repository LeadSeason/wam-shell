import { test, eq } from "./framework"
import { serialize, parse, decide } from "../src/lib/sleepTimerState"
import type { SleepTimerState } from "../src/lib/sleepTimerState"

const base: SleepTimerState = {
    deadline: 1_800_000_000_000,
    paused: false,
    pausedSeconds: 0,
    dim: null,
    pid: 1234,
}

test("sleepTimerState: serialize/parse round-trips", () => {
    eq(parse(serialize(base)), base)
    eq(
        parse(serialize({ ...base, paused: true, pausedSeconds: 420, dim: { pre: 0.7, to: 0.35 } })),
        { ...base, paused: true, pausedSeconds: 420, dim: { pre: 0.7, to: 0.35 } },
    )
})

test("sleepTimerState: parse rejects malformed input", () => {
    eq(parse(""), null)
    eq(parse("not json"), null)
    eq(parse('{"deadline":"soon"}'), null)
    eq(parse("42"), null)
    // dim is optional and strictly validated
    eq(parse(serialize({ ...base, dim: null }))!.dim, null)
    eq(parse(JSON.stringify({ ...base, dim: { pre: "x" } }))!.dim, null)
    // pid is optional and defaults to 0 (unknown owner): missing or
    // wrong-typed must not reject the file
    eq(parse(JSON.stringify({ deadline: null }))!.pid, 0)
    eq(parse(JSON.stringify({ deadline: null, pid: "bash" }))!.pid, 0)
})

test("sleepTimerState decide: empty and owned", () => {
    const now = 1_000_000
    eq(decide(null, now, now), "empty")
    // fresh mtime + a live owner pid = a live shell owns the timer
    eq(decide(base, now, now - 1000, 3000, true), "owned")
    eq(decide(base, now, now - 2999, 3000, true), "owned")
    // fresh mtime but the owner is DEAD (crash/kill or a fast clean
    // restart inside the beacon window): adopt, don't drop
    eq(decide(base, now, now - 1000, 3000, false), "live")
    // stale mtime is adoptable even if the pid looks alive
    eq(decide(base, now, now - 3000, 3000, true), "live")
})

test("sleepTimerState decide: live vs expired on the deadline boundary", () => {
    const now = 1_000_000
    const stale = now - 10_000
    eq(decide({ ...base, deadline: now + 1 }, now, stale), "live")
    eq(decide({ ...base, deadline: now }, now, stale), "expired")
    eq(decide({ ...base, deadline: now - 1 }, now, stale), "expired")
})

test("sleepTimerState decide: paused beats the deadline check", () => {
    const now = 1_000_000
    const stale = now - 10_000
    // paused with a past deadline is still a frozen restore, not an expiry
    eq(decide({ ...base, deadline: now - 500, paused: true, pausedSeconds: 30 }, now, stale), "paused")
})

test("sleepTimerState decide: dim-only after a pre-restart fire", () => {
    const now = 1_000_000
    const stale = now - 10_000
    eq(
        decide({ deadline: null, paused: false, pausedSeconds: 0, dim: { pre: 0.7, to: 0.35 } }, now, stale),
        "dim-only",
    )
    // no deadline and no dim is nothing
    eq(decide({ deadline: null, paused: false, pausedSeconds: 0, dim: null }, now, stale), "empty")
})
