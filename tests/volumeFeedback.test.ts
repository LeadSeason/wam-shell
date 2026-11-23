import { test, eq } from "./framework"
import { ClickPacer, DeliveryWatch } from "../src/lib/volumeFeedback"

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

// DeliveryWatch: push-buffer returning OK only says the sample entered
// the pipeline. The decision it must make: a queue that still holds a
// whole sample `graceMs` after its push is not delivering, and two
// such readings in a row retire the native path — while a fast ramp
// under a fat sink quantum (one sample in flight, never two) must
// never trip it, because a false retire costs the session its native
// path permanently.

const SAMPLE = 100

function watch(): [DeliveryWatch, number[]] {
    const retired: number[] = []
    return [new DeliveryWatch(() => retired.push(1)), retired]
}

test("watch: a draining queue never retires", () => {
    const [w, retired] = watch()
    eq(w.check(0, SAMPLE), false)
    eq(w.check(90, SAMPLE), false, "below one sample: consuming at real time")
    eq(w.check(SAMPLE - 1, SAMPLE), false)
    eq(retired.length, 0)
})

test("watch: an undrained sample is a strike, not a retire", () => {
    const [w, retired] = watch()
    eq(w.check(SAMPLE * 2, SAMPLE), false)
    eq(retired.length, 0, "a single stalled reading gets no verdict yet")
    eq(w.strikes, 1)
})

test("watch: two undrained readings in a row retire the path", () => {
    const [w, retired] = watch()
    eq(w.check(SAMPLE * 2, SAMPLE), false, "first strike")
    eq(w.check(SAMPLE * 3, SAMPLE), true, "second consecutive strike retires")
    eq(retired.length, 1)
    eq(w.hasRetired, true)
})

test("watch: a drain between strikes resets them", () => {
    const [w, retired] = watch()
    w.check(SAMPLE * 2, SAMPLE)
    eq(w.check(0, SAMPLE), false, "the queue drained: healthy again")
    eq(w.strikes, 0)
    w.check(SAMPLE * 2, SAMPLE)
    eq(retired.length, 0, "the second strike never accumulated")
})

test("watch: a fast ramp under a fat quantum never strikes", () => {
    // 100ms spacing, 67ms sample, one fat quantum of slack: the queue
    // may hold a sample and a fraction, but never two
    const [w, retired] = watch()
    for (const level of [70, 130, 160, 199]) eq(w.check(level, SAMPLE), false)
    eq(retired.length, 0)
})

test("watch: retire fires once, further checks stay retired", () => {
    const [w, retired] = watch()
    w.check(SAMPLE * 2, SAMPLE)
    w.check(SAMPLE * 2, SAMPLE)
    eq(w.check(SAMPLE * 2, SAMPLE), false, "no repeat verdicts")
    eq(retired.length, 1)
})

test("watch: reset clears strikes and the verdict", () => {
    const [w, retired] = watch()
    w.check(SAMPLE * 2, SAMPLE)
    w.check(SAMPLE * 2, SAMPLE)
    eq(retired.length, 1)
    w.reset()
    eq(w.hasRetired, false)
    eq(w.check(SAMPLE * 2, SAMPLE), false, "strikes start over after reset")
    eq(retired.length, 1, "reset does not un-fire an already-made verdict")
})
