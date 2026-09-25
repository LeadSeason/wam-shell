import { test, eq } from "./framework"
import { createHoldable } from "../src/lib/hold"

// the shape the notification center's clear-all depends on: N publishes
// under one hold must produce exactly ONE subscriber catch-up, carrying
// the value the release's catchUp() returns — per-update propagation is
// what made clearing ~1.2k rows quadratic and froze the shell

test("hold: publishes propagate while unheld", () => {
    const h = createHoldable<number[]>([1])
    let seen: number[] = []
    let calls = 0
    const dispose = h.accessor.subscribe(() => {
        calls++
        seen = h.accessor.get()
    })
    h.publish([1, 2])
    eq(calls, 1)
    eq(seen, [1, 2])
    h.publish([1, 2, 3])
    eq(calls, 2)
    eq(seen, [1, 2, 3])
    dispose()
})

test("hold: publishes are swallowed while held, catch-up once on release", () => {
    const h = createHoldable("a")
    let calls = 0
    let seen = ""
    const dispose = h.accessor.subscribe(() => {
        calls++
        seen = h.accessor.get()
    })
    eq(h.held(), false)
    const release = h.acquire(() => "live-again")
    eq(h.held(), true)
    h.publish("b")
    h.publish("c")
    eq(calls, 0, "no subscriber notification while held")
    release()
    eq(h.held(), false)
    eq(calls, 1, "exactly one catch-up after release")
    eq(seen, "live-again", "catch-up carries catchUp()'s value, not a swallowed one")
    dispose()
})

test("hold: no publish during the hold means no catch-up", () => {
    const h = createHoldable(0)
    let calls = 0
    const dispose = h.accessor.subscribe(() => calls++)
    const release = h.acquire(() => 99)
    release()
    eq(calls, 0, "nothing changed, so nothing was published")
    dispose()
})

test("hold: nested holds catch up once, on the outermost release", () => {
    const h = createHoldable(0)
    let calls = 0
    let seen = 0
    const dispose = h.accessor.subscribe(() => {
        calls++
        seen = h.accessor.get()
    })
    const outer = h.acquire(() => 3)
    const inner = h.acquire(() => 3)
    h.publish(1)
    inner()
    eq(calls, 0, "inner release still leaves the outer hold")
    h.publish(2)
    outer()
    eq(calls, 1)
    eq(seen, 3)
    dispose()
})

test("hold: release is idempotent", () => {
    const h = createHoldable(0)
    let calls = 0
    const dispose = h.accessor.subscribe(() => calls++)
    const release = h.acquire(() => 1)
    h.publish(5)
    release()
    release()
    eq(calls, 1, "second release does not publish again")
    eq(h.held(), false)
    dispose()
})

test("hold: markMissed records a miss without producing the value", () => {
    // the notifd handler's held path: skip the costly re-read entirely
    // and let the release catch-up supply the value — a clear-all
    // draining the daemon MUST still update subscribers at release
    const h = createHoldable("a")
    let calls = 0
    let seen = ""
    const dispose = h.accessor.subscribe(() => {
        calls++
        seen = h.accessor.get()
    })
    const release = h.acquire(() => "fresh-read")
    h.markMissed()
    h.markMissed()
    eq(calls, 0, "no notification while held")
    release()
    eq(calls, 1, "exactly one catch-up")
    eq(seen, "fresh-read", "catch-up value comes from catchUp()")
    dispose()
})

test("hold: markMissed while unheld leaves nothing pending", () => {
    // a stale unheld mark must not trigger a spurious catch-up later
    const h = createHoldable(0)
    let calls = 0
    const dispose = h.accessor.subscribe(() => calls++)
    h.markMissed()
    const release = h.acquire(() => 99)
    release()
    eq(calls, 0)
    dispose()
})

test("hold: publishes flow again between two holds", () => {
    const h = createHoldable(0)
    let calls = 0
    const dispose = h.accessor.subscribe(() => calls++)
    let release = h.acquire(() => 1)
    h.publish(1)
    release()
    eq(calls, 1)
    h.publish(2)
    eq(calls, 2, "unheld publishes flow again after a release")
    release = h.acquire(() => 4)
    h.publish(3)
    release()
    eq(calls, 3)
    eq(h.accessor.get(), 4)
    dispose()
})
