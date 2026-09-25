import { createState } from "gnim"

/** A state source whose updates can be held back.
 *
 * `publish` feeds the current value to subscribers. While at least one
 * hold is active (via `acquire`), publishes are swallowed; when the last
 * hold releases, the value from `catchUp` is published exactly once, so
 * subscribers see one update with everything they missed. Callers that
 * pay to PRODUCE a value (say, marshalling a GObject list per emit)
 * should skip producing it while `held()` and let `catchUp` re-read the
 * source at release — a stale intermediate value has no readers anyway.
 *
 * Why this exists: the notification daemon emits its list change for
 * every single resolve, and everything derived from that list used to
 * re-run per emit. Dismissing ~1.2k notifications from the center's
 * clear-all re-derived and re-rendered the whole center per row —
 * quadratic, seconds of frozen main loop. Holds make a whole clear one
 * recompute.
 */
export function createHoldable<T>(initial: T) {
    const [accessor, setValue] = createState(initial)
    let holds = 0
    let pending = false

    return {
        accessor,
        held(): boolean {
            return holds > 0
        },
        publish(next: T) {
            if (holds > 0) {
                pending = true
                return
            }
            setValue(next)
        },
        /** Record that the source changed while held, WITHOUT producing
         *  the value — for sources where producing it is itself the cost
         *  (the daemon's notification list is ~0.8ms to marshal per emit).
         *  The release's catchUp re-reads the source instead. No-op when
         *  not held: an unheld change is published normally. */
        markMissed() {
            if (holds > 0) pending = true
        },
        /** Hold updates until the returned release function runs.
         *  Reentrant: the catch-up fires when the OUTERMOST hold
         *  releases, and only if a publish was missed. */
        acquire(catchUp: () => T): () => void {
            holds++
            let released = false
            return () => {
                if (released) return
                released = true
                holds--
                if (holds === 0) {
                    const missed = pending
                    pending = false
                    if (missed) setValue(catchUp())
                }
            }
        },
    }
}

export type Holdable<T> = ReturnType<typeof createHoldable<T>>
