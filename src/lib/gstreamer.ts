import Gst from "gi://Gst?version=1.0"

// One place for the gstreamer-init incantation and the trap it works
// around. gjs insists on the argv argument at runtime even though the
// gir marks it optional — `undefined` is rejected outright ("Expected
// type utf8 for Argument 'argv' but got type 'undefined'"; #364
// shipped exactly that and it retired the volume-click pipeline for
// whole sessions), while `null` fails the typecheck: the typings type
// the parameter `string[] | undefined`, not nullable. An empty array
// satisfies both.

let ready = false

/** Initialise gstreamer once per process. False when it cannot be —
 *  idempotent, never throws, safe to call before every operation; the
 *  caller decides what "no gstreamer" means for it (skip, reject, or
 *  fall back). */
export function ensureGst(): boolean {
    if (ready) return true
    try {
        Gst.init([])
        ready = true
    } catch {
        // init failure is permanent for the process; whether and how
        // to say so is the caller's call — this can sit on a
        // per-click path
    }
    return ready
}
