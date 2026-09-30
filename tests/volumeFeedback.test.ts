import { test, eq } from "./framework"
import { ClickPacer } from "../src/lib/volumeFeedback"

// The volume OSD's audio feedback must not spawn a player per key-repeat
// step, nor swallow the last click of a burst. ClickPacer folds events
// inside the window onto ONE slot at the window's end and never pushes
// that slot out — the pacer is the whole decision, and it is GTK-free so
// these cases can drive it with a plain fake clock.

const MIN = 80

test("pacer: first request is immediate", () => {
    const p = new ClickPacer(MIN)
    eq(p.request(1000), 0)
    eq(p.pendingSlot, null)
})

test("pacer: request inside the window defers to the window's end", () => {
    const p = new ClickPacer(MIN)
    p.request(1000)
    const delay = p.request(1010)
    eq(delay, 70, "fires when the window from the last click ends")
    eq(p.pendingSlot, 1080)
})

test("pacer: later events do not push the armed slot out", () => {
    // a held key produces a dense event stream; if every event re-armed
    // the trailing click relative to ITSELF, a continuous ramp would
    // never tick at all and the burst would end on one lonely click
    const p = new ClickPacer(MIN)
    p.request(1000)
    eq(p.request(1010), 70)
    eq(p.request(1040), 40, "same absolute slot, nearer now")
    eq(p.request(1079), 1)
    eq(p.pendingSlot, 1080, "slot never moved past the first window end")
})

test("pacer: request at the window end is immediate again", () => {
    const p = new ClickPacer(MIN)
    p.request(1000)
    p.request(1010)
    eq(p.request(1080), 0)
    eq(p.pendingSlot, null, "the armed slot is superseded by the immediate click")
})

test("pacer: the trailing click re-opens the window from its own start", () => {
    // the module stamps fired(slotTime) when the timer runs, so the tick
    // itself throttles what follows — otherwise a click at 1080 right
    // after the slot's click at 1080 would machine-gun
    const p = new ClickPacer(MIN)
    p.request(1000)
    p.request(1010)
    p.fired(1080) // the trailing click started at the slot
    eq(p.request(1090), 70)
    eq(p.pendingSlot, 1160)
})

test("pacer: an immediate request also re-opens the window", () => {
    const p = new ClickPacer(MIN)
    p.request(1000)
    p.request(1085) // window elapsed -> immediate; request() records it
    eq(p.request(1100), 65, "throttled against the immediate click, not the old one")
})

test("pacer: reset clears the clock", () => {
    const p = new ClickPacer(MIN)
    p.request(1000)
    p.request(1010)
    p.reset()
    eq(p.request(1015), 0, "nothing pending after reset")
    eq(p.pendingSlot, null)
})
