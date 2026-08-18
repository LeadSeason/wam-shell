import Gdk from "gi://Gdk?version=4.0"

/**
 * Turn a stream of scroll deltas into discrete ±1 steps.
 *
 * The two input devices behave nothing alike, and a handler written for
 * one is unusable on the other:
 *
 * - A **mouse wheel** delivers one event per notch (`WHEEL` unit, with a
 *   magnitude that varies by compositor — ±2 on Hyprland here). One
 *   event is one step, and the magnitude is noise.
 * - A **touchpad** streams small smooth deltas (`SURFACE` unit, dozens
 *   per flick). Treating each as a step walks the entire workspace list
 *   in one gesture, which is how a nudge becomes a teleport.
 *
 * So touchpad travel is accumulated and spends a step per threshold
 * crossed. Reversing direction drops whatever travel was banked: after
 * an overshoot the correction should answer immediately rather than
 * first paying off the leftover.
 *
 * One stepper per controller — it carries that controller's travel.
 *
 * Continuous controls — the volume/brightness indicators and the panel
 * sliders — use `scrollDelta` below instead: they do not need the
 * accumulator (an over-fast touchpad just moves further and you stop),
 * only the unit split. Anything discrete — a workspace, a layout, a
 * player — needs the accumulator.
 */
export function createScrollStepper(threshold = 12) {
    let travel = 0

    return (controller: { get_unit(): Gdk.ScrollUnit }, dy: number): -1 | 0 | 1 => {
        if (dy === 0) return 0

        if (controller.get_unit() === Gdk.ScrollUnit.WHEEL) {
            travel = 0
            return dy < 0 ? -1 : 1
        }

        // direction flip: drop the banked travel, don't net it off
        if (travel !== 0 && Math.sign(travel) !== Math.sign(dy)) travel = 0
        travel += dy
        if (Math.abs(travel) < threshold) return 0
        travel = 0
        return dy < 0 ? -1 : 1
    }
}

/**
 * One continuous scroll delta from any device.
 *
 * Continuous controls (a volume, a brightness) do not need the stepper
 * above, but they DO need the unit split: a mouse wheel delivers one
 * event per notch (`WHEEL` unit; magnitude varies by compositor — ±2 on
 * Hyprland here) and answers to a fixed step per notch, while a
 * touchpad streams small smooth deltas (`SURFACE` unit) that must apply
 * proportionally — a fixed step per event turns one flick into dozens
 * of jumps.
 *
 * @param wheelStep fraction of the range per wheel notch
 * @returns signed delta to ADD to the current value; ~0.1%/unit on a
 *          touchpad, matching the established brightness feel
 */
export function scrollDelta(
    controller: { get_unit(): Gdk.ScrollUnit },
    dy: number,
    wheelStep: number,
): number {
    if (controller.get_unit() === Gdk.ScrollUnit.WHEEL) return dy < 0 ? wheelStep : -wheelStep
    return -dy * 0.001
}

/**
 * Pick the neighbour of `current` in `items`, `dir` places away.
 *
 * Clamped, deliberately not wrapping: with `hide_empty` on, the list is
 * only the workspaces that exist right now, so wrapping from the last to
 * the first is a jump across the whole desktop in response to one notch.
 * Returns null when there is nowhere to go — including when `current` is
 * not in the list at all, which happens for a beat after a workspace is
 * created on another monitor.
 */
export function stepThrough<T>(items: T[], current: T | undefined, dir: -1 | 0 | 1): T | null {
    if (dir === 0 || items.length === 0) return null
    const at = current === undefined ? -1 : items.indexOf(current)
    if (at < 0) return null
    const next = at + dir
    if (next < 0 || next >= items.length) return null
    return items[next] ?? null
}
