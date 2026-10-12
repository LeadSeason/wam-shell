import { test, eq } from "./framework"
import {
    armSnooze,
    clearSnooze,
    dndWanted,
    expireSnooze,
    formatMinutes,
    formatRemaining,
    initialDndSnoozeState,
    formatRemainingCompact,
    manualToggle,
    setShareSnooze,
    setSharing,
} from "../src/lib/dndSnooze"

const NOW = 1_000_000_000_000

// starting points used across the table
const off = () => initialDndSnoozeState(false, false)
const on = () => initialDndSnoozeState(true, false)
const auto = () => initialDndSnoozeState(false, true) // armed, not sharing

const want = (s: { resting: boolean; until: number | null; sharing: boolean; auto: boolean }) =>
    dndWanted(s)

test("dndSnooze: arming turns DND on; expiry restores the resting value", () => {
    const armed = armSnooze(off(), 45, NOW)
    eq(armed.set, true)
    eq(armed.next.until, NOW + 45 * 60_000)
    // expiry: back to off — the pre-snooze value
    const expired = expireSnooze(armed.next)
    eq(expired.set, false)
    eq(expired.next.until, null)
    // DND permanently on before the snooze: expiry returns to on
    const armedOn = armSnooze(on(), 30, NOW)
    eq(expireSnooze(armedOn.next).set, true)
})

test("dndSnooze: re-arming mid-snooze moves the deadline, not the resting value", () => {
    const armed = armSnooze(off(), 15, NOW)
    const reArmed = armSnooze(armed.next, 60, NOW + 60_000)
    eq(reArmed.next.until, NOW + 60_000 + 60 * 60_000)
    eq(reArmed.next.resting, false)
    eq(reArmed.set, true)
    // and it still expires back to off
    eq(expireSnooze(reArmed.next).set, false)
})

test("dndSnooze: share hold engages only when armed AND sharing", () => {
    eq(want(auto()), false) // armed, but nothing is being shared
    const sharing = setSharing(auto(), true)
    eq(sharing.set, true) // the hold is up
    // capture ends: hold lifts, back to off
    eq(setSharing(sharing.next, false).set, false)
    // sharing without the preference never holds
    eq(setSharing(off(), true).set, false)
    // ticking the checkbox WHILE sharing engages immediately
    const tickedWhileSharing = setShareSnooze(setSharing(off(), true).next, true)
    eq(tickedWhileSharing.set, true)
})

test("dndSnooze: share hold releases to the resting value", () => {
    // DND permanently on, armed for sharing: after the capture ends the
    // user's own DND is still wanted
    const held = setSharing(on(), true)
    eq(held.set, true)
    eq(setSharing(held.next, false).set, true)
})

test("dndSnooze: holds overlap — last hold lifted releases DND", () => {
    // timed snooze running, share hold engages, snooze expires mid-share
    const armed = armSnooze(auto(), 15, NOW).next
    const shared = setSharing(armed, true)
    eq(shared.set, true)
    const expiredMidShare = expireSnooze(shared.next)
    eq(expiredMidShare.set, true) // the share hold keeps DND up
    // share ends: now everything is gone, DND returns to off
    eq(setSharing(expiredMidShare.next, false).set, false)
})

test("dndSnooze: a manual toggle is the newest intent and drops every hold", () => {
    // clicking DND off mid-snooze cancels the restore
    const armed = armSnooze(off(), 45, NOW).next
    const clicked = manualToggle(armed)
    eq(clicked.set, false)
    eq(clicked.next.until, null)
    eq(clicked.next.resting, false)
    // expiring afterwards must stay off (no stale deadline resurrects DND)
    eq(expireSnooze(clicked.next).set, false)
    // clicking off during a share hold unticks the standing preference:
    // left armed it would re-engage on the next capture
    const held = setSharing(auto(), true)
    eq(held.set, true)
    const clickedOff = manualToggle(held.next)
    eq(clickedOff.set, false)
    eq(clickedOff.next.auto, false)
    eq(clickedOff.next.sharing, true) // the capture is still running
    // ...and it does not re-engage until the user re-ticks
    eq(setSharing(clickedOff.next, false).set, false)
    eq(setSharing(clickedOff.next, true).set, false)
})

test("dndSnooze: toggling acts on the effective state, not the resting one", () => {
    // DND off, snoozed (button shows ON): a click means OFF
    const armed = armSnooze(off(), 45, NOW).next
    eq(dndWanted(armed), true)
    eq(manualToggle(armed).next.resting, false)
    // DND off, no holds: a click means ON, plain and simple
    eq(manualToggle(off()).next.resting, true)
    // checkbox state survives a plain toggle when nothing is sharing
    eq(manualToggle(auto()).next.auto, true)
})

test("dndSnooze: setting the preference applies immediately, both ways", () => {
    const unticked = setShareSnooze(setSharing(auto(), true).next, false)
    eq(unticked.set, false) // hold drops the moment it is unticked
    eq(setShareSnooze(off(), true).set, false) // no capture: nothing to hold
})

test("dndSnooze: clearSnooze without a snooze is a no-op", () => {
    const cleared = clearSnooze(off())
    eq(cleared.next, off())
    eq(cleared.set, false)
})

test("dndSnooze: formats", () => {
    eq(formatMinutes(15), "15m")
    eq(formatMinutes(45), "45m")
    eq(formatMinutes(60), "1h")
    eq(formatMinutes(90), "1h 30m")
    eq(formatMinutes(120), "2h")
    // floored remaining minutes: at 44:30 the label reads "44m", not
    // "45m" — the countdown matches the minutes actually left. the
    // final stretch just reads "1m": minute precision is all this needs
    eq(formatRemaining(44.5 * 60_000), "44m")
    eq(formatRemainingCompact(44.5 * 60_000), "44m")
    eq(formatRemaining(60 * 60_000), "1h")
    eq(formatRemaining(60 * 60_000 - 1), "59m")
    eq(formatRemaining(61_000), "1m")
    eq(formatRemaining(59_999), "1m")
    eq(formatRemaining(999), "1m")
    eq(formatRemaining(0), "1m")
    eq(formatRemaining(-5), "1m")
    // the button's tight form: same flooring, no space
    eq(formatRemainingCompact(45 * 60_000), "45m")
    eq(formatRemainingCompact(60 * 60_000), "1h")
    eq(formatRemainingCompact(90 * 60_000), "1h30m")
    eq(formatRemainingCompact(90 * 60_000 - 1), "1h29m")
    eq(formatRemainingCompact(61_000), "1m")
    eq(formatRemainingCompact(59_999), "1m")
    eq(formatRemainingCompact(0), "1m")
})
