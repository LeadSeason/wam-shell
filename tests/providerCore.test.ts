import { test, eq } from "./framework"
import {
    BANNER_HORIZON_SEC,
    bannerCandidates,
    createRefreshGate,
    formatWait,
    isBackoffStatus,
    newArrivals,
    retryAfterSeconds,
} from "../src/lib/providerCore"
import { Provider, providers, registerProvider } from "../src/lib/notificationProviders"

// These were four byte-identical copies across the providers. The
// banner horizon in particular is a safety rule, not a convenience:
// without it, a provider coming back after an outage banners everything
// it missed, all at once.

test("providerCore newArrivals: only ids prev did not carry", () => {
    const prev = [{ id: "a" }, { id: "b" }]
    eq(newArrivals(prev, [{ id: "b" }, { id: "c" }]), ["c"])
    eq(newArrivals(prev, prev), [])
    eq(newArrivals([], [{ id: "a" }]), ["a"])
    eq(newArrivals(prev, []), [])
})

test("providerCore newArrivals: an item keeping its id stays quiet", () => {
    // new activity on an already-unread GitHub thread, an edited Todoist
    // task: same id, so no second banner
    eq(newArrivals([{ id: "x" }], [{ id: "x" }]), [])
})

test("providerCore bannerCandidates: unknown and recent", () => {
    const now = 1_800_000_000
    const item = (id: string, ageSec: number) => ({ id, time: now - ageSec })
    const next = [
        item("fresh", 3600),
        item("known", 60),
        item("ancient", 7 * 86_400),
    ]
    eq(
        bannerCandidates(next, new Set(["known"]), now).map(i => i.id),
        ["fresh"],
    )
})

test("providerCore bannerCandidates: the horizon is inclusive at the edge", () => {
    const now = 1_800_000_000
    const atEdge = { id: "edge", time: now - BANNER_HORIZON_SEC }
    const justPast = { id: "past", time: now - BANNER_HORIZON_SEC - 1 }
    eq(
        bannerCandidates([atEdge, justPast], new Set(), now).map(i => i.id),
        ["edge"],
    )
})

test("providerCore bannerCandidates: a custom horizon overrides the default", () => {
    const now = 1_800_000_000
    const item = { id: "a", time: now - 120 }
    eq(bannerCandidates([item], new Set(), now, 60), [])
    eq(bannerCandidates([item], new Set(), now, 300).length, 1)
})

test("providerCore bannerCandidates: an item in the future still banners", () => {
    // a Todoist task scheduled for later today, a clock skew between the
    // service and the machine: the horizon bounds the PAST only
    const now = 1_800_000_000
    eq(bannerCandidates([{ id: "soon", time: now + 3600 }], new Set(), now).length, 1)
})

test("providerCore refresh gate: the first call runs, the next is swallowed", () => {
    let polls = 0
    const gate = createRefreshGate(60_000, () => polls++)
    gate.refresh()
    gate.refresh()
    gate.refresh()
    eq(polls, 1)
})

test("providerCore refresh gate: a poll from elsewhere closes the window too", () => {
    // the scheduled timer and mutations call touch(): a poll that just
    // ran is a poll, whoever started it, and opening the center right
    // after must not spend a second request
    let polls = 0
    const gate = createRefreshGate(60_000, () => polls++)
    gate.touch()
    gate.refresh()
    eq(polls, 0)
})

test("providerCore refresh gate: a zero window never gates", () => {
    let polls = 0
    const gate = createRefreshGate(0, () => polls++)
    gate.refresh()
    gate.refresh()
    eq(polls, 2)
})

// ------------------------------------------------------ the registry

const stub = (name: string): Provider => ({
    name,
    iconName: `${name}-symbolic`,
    items: { get: () => [] } as any,
    refresh: () => {},
    // no `dispose`: teardown goes through lib/lifecycle, not the
    // registry — the interface member it used to require was implemented
    // by every provider and called by nothing
})

test("notificationProviders: registration is append-only and ordered", () => {
    const before = providers.length
    registerProvider(stub("test-alpha"))
    registerProvider(stub("test-beta"))
    eq(providers.length, before + 2)
    eq(
        providers.slice(before).map(p => p.name),
        ["test-alpha", "test-beta"],
    )
})

test("notificationProviders: a duplicate name is ignored, the first wins", () => {
    // the center builds a filter chip per registered provider and keys
    // its merged list by index — a second entry under one name would
    // draw two identical chips and count its items twice
    registerProvider(stub("test-dupe"))
    const first = providers.find(p => p.name === "test-dupe")
    registerProvider({ ...stub("test-dupe"), iconName: "different" })
    eq(providers.filter(p => p.name === "test-dupe").length, 1)
    eq(providers.find(p => p.name === "test-dupe"), first)
})

// --- rate-limit backoff ----------------------------------------------

test("retryAfterSeconds: a bare integer is a delay in seconds", () => {
    eq(retryAfterSeconds("60", 1), 60)
    eq(retryAfterSeconds("  120  ", 1), 120)
})

test("retryAfterSeconds: an HTTP date is honoured, and the past means now", () => {
    const now = Date.parse("Sun, 09 Aug 2026 12:00:00 GMT")
    eq(retryAfterSeconds("Sun, 09 Aug 2026 12:01:00 GMT", 1, now), 60)
    // a date already gone must not become a negative (or zero) wait
    eq(retryAfterSeconds("Sun, 09 Aug 2026 11:00:00 GMT", 1, now), 1)
})

test("retryAfterSeconds: no usable header doubles per consecutive failure", () => {
    eq(retryAfterSeconds("", 1), 30)
    eq(retryAfterSeconds("", 2), 60)
    eq(retryAfterSeconds("", 3), 120)
    // garbage is the same as absent, not a throw
    eq(retryAfterSeconds("soon", 1), 30)
})

test("retryAfterSeconds: clamped at both ends", () => {
    // 0 would busy-loop
    eq(retryAfterSeconds("0", 1), 1)
    // a server asking for a day is not honoured silently on a desktop
    eq(retryAfterSeconds("86400", 1), 3600)
    // and the doubling fallback cannot run away either
    eq(retryAfterSeconds("", 20), 3600)
})

test("isBackoffStatus: rate limit and overload only", () => {
    eq(isBackoffStatus(429), true)
    eq(isBackoffStatus(503), true)
    // ordinary failures keep the old "retry next poll" behaviour
    eq(isBackoffStatus(500), false)
    eq(isBackoffStatus(401), false)
    eq(isBackoffStatus(200), false)
})

test("refresh gate: a backoff blocks refresh until cleared", () => {
    let polls = 0
    const gate = createRefreshGate(0, () => polls++)
    gate.refresh()
    eq(polls, 1)
    gate.backOff(60)
    eq(gate.blocked(), true)
    gate.refresh()
    eq(polls, 1) // still 1: the backoff held it
    gate.clearBackoff()
    eq(gate.blocked(), false)
    gate.refresh()
    eq(polls, 2)
})

test("refresh gate: backOff never shortens an existing hold", () => {
    const gate = createRefreshGate(0, () => {})
    gate.backOff(600)
    const long = gate.blockedFor()
    gate.backOff(1) // a shorter one must not win
    eq(gate.blockedFor() >= long - 1, true)
})

test("formatWait: coarse, and never rounds down to zero", () => {
    eq(formatWait(1), "1s")
    eq(formatWait(45), "45s")
    eq(formatWait(0.4), "1s")
    eq(formatWait(90), "2m")
    eq(formatWait(2400), "40m")
    eq(formatWait(3600), "1h")
    eq(formatWait(5400), "1.5h")
})
