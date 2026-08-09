import GLib from "gi://GLib?version=2.0"
import { onCleanup } from "gnim"
import { timeoutAdd, sourceRemove } from "../lib/metrics"

// One-shot delays that belong to a widget.
//
// Several panes needed the same thing: clear an error message after four
// seconds, drop a pending spinner after five, give up on a NetworkManager
// connect after forty-five. Every one of them reached for the GJS global
// `setTimeout`, which has two problems.
//
// The first is that it is invisible to lib/metrics. The timer counters
// are what the perf gate reads to catch a leak (`timers.alive` by label),
// and a source created outside the wrappers never appears in them — so
// exactly the code most likely to leak a timer was the code the leak
// detector could not see. AGENTS.md says new code must use the wrappers;
// these predated the rule and quietly stayed.
//
// The second is that nothing cancelled them. Each site guarded itself
// with a generation counter, so the BEHAVIOUR was right — a stale
// callback compared its token and did nothing — but the source still sat
// in the main loop after the pane was gone, up to 45 seconds in the
// worst case, holding its closure alive.
//
// `createDelayer` is called during component setup, where onCleanup is
// available, and returns a function that is safe to call from anywhere
// afterwards — including inside a gesture handler, which is where half of
// these live and where onCleanup cannot be reached.
export function createDelayer(label: string) {
    const live = new Set<number>()

    onCleanup(() => {
        for (const id of live) sourceRemove(id)
        live.clear()
    })

    /** run `fn` once after `ms`, unless the widget goes away first */
    return function delay(ms: number, fn: () => void): void {
        // assigned before the callback can fire: the main loop is not
        // re-entered from here (same reasoning as lib/metrics' wrappers)
        let id = 0
        id = timeoutAdd(label, GLib.PRIORITY_DEFAULT, ms, () => {
            live.delete(id)
            fn()
            return GLib.SOURCE_REMOVE
        })
        live.add(id)
    }
}
