import GLib from "gi://GLib?version=2.0"

// Smooth-scroll devices emit a stream of small deltas per gesture, so
// feeding raw dy to a switcher fires a frenzy of switches per flick.
// One cycler owns the accumulator for one switchable list; call the
// function it returns straight from an EventControllerScroll.
//
// Shared by the media card's player switcher and the power pane's GPU
// switcher: same gesture, same debounce, and a second copy would drift
// out of sync with the first.

// one accumulated wheel notch switches once...
const NOTCH = 1
// ...and at most once per this many seconds, so a touchpad flick cannot
// chain-switch through the whole list
const COOLDOWN = 0.3
// a gesture that pauses longer than this starts its accumulator over
const GESTURE_GAP = 0.5

export function createScrollCycler(cycle: (direction: 1 | -1) => void): (dy: number) => void {
    let acc = 0
    let at = 0
    let last = 0
    return (dy: number) => {
        if (dy === 0) return
        const now = GLib.get_monotonic_time() / 1e6
        // drop the momentum tail right after a switch
        if (now - last < COOLDOWN) {
            acc = 0
            at = now
            return
        }
        if (now - at > GESTURE_GAP) acc = 0
        at = now
        acc += dy
        if (Math.abs(acc) >= NOTCH) {
            const direction = acc > 0 ? 1 : -1
            last = now
            acc = 0
            cycle(direction)
        }
    }
}
