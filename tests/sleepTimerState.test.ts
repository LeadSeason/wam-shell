import { test, eq } from "./framework"
import { serialize, parse, decide } from "../src/lib/sleepTimerState"
import type { SleepTimerState } from "../src/lib/sleepTimerState"

const base: SleepTimerState = {
    deadline: 1_800_000_000_000,
    paused: false,
    pausedSeconds: 0,
    dim: null,
    mutedStreams: [],
    pid: 1234,
}

test("sleepTimerState: serialize/parse round-trips", () => {
    eq(parse(serialize(base)), base)
    eq(
        parse(
            serialize({ ...base, paused: true, pausedSeconds: 420, dim: { pre: 0.7, to: 0.35 } }),
        ),
        { ...base, paused: true, pausedSeconds: 420, dim: { pre: 0.7, to: 0.35 } },
    )
    eq(
        parse(serialize({ ...base, mutedStreams: [[183, "Firefox"], [186, "mpv"]] }))!.mutedStreams,
        [[183, "Firefox"], [186, "mpv"]],
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
    // mutedStreams defaults to [] when absent (files predating the field)
    eq(parse(JSON.stringify({ deadline: null }))!.mutedStreams, [])
    // bare ids (the pre-pair format) adopt with an unknown app; junk
    // entries drop
    eq(parse(JSON.stringify({ deadline: null, mutedStreams: [1, "x", 2] }))!.mutedStreams, [
        [1, ""],
        [2, ""],
    ])
    eq(parse(JSON.stringify({ deadline: null, mutedStreams: [[3, "Firefox"], [4, 9]] }))!.mutedStreams, [
        [3, "Firefox"],
        [4, ""],
    ])
})

test("sleepTimerState decide: empty and owned", () => {
    const now = 1_000_000
    eq(decide(null, now), "empty")
    // a live owner pid = a live shell owns the timer, however old the
    // file is (the owner writes on state change only, not per tick)
    eq(decide(base, now, true), "owned")
    // a DEAD owner (crash/kill or a clean restart): adopt, don't drop
    eq(decide(base, now, false), "live")
})

test("sleepTimerState decide: live vs expired on the deadline boundary", () => {
    const now = 1_000_000
    eq(decide({ ...base, deadline: now + 1 }, now), "live")
    eq(decide({ ...base, deadline: now }, now), "expired")
    eq(decide({ ...base, deadline: now - 1 }, now), "expired")
})

test("sleepTimerState decide: paused beats the deadline check", () => {
    const now = 1_000_000
    // paused with a past deadline is still a frozen restore, not an expiry
    eq(decide({ ...base, deadline: now - 500, paused: true, pausedSeconds: 30 }, now), "paused")
})

test("sleepTimerState decide: dim-only after a pre-restart fire", () => {
    const now = 1_000_000
    eq(
        decide(
            { deadline: null, paused: false, pausedSeconds: 0, dim: { pre: 0.7, to: 0.35 } },
            now,
        ),
        "dim-only",
    )
    // no deadline and no dim is nothing
    eq(decide({ deadline: null, paused: false, pausedSeconds: 0, dim: null }, now), "empty")
})
