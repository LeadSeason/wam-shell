import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { createState } from "gnim"
import { execAsync, timeoutAdd, sourceRemove } from "./metrics"
import { streamLines } from "./streamLines"

// Screen-share detection, event-driven through PipeWire itself. Any
// node with media.class Stream/Input/Video means a capture is active
// (portal screencast, camera grab). pw-dump -m streams graph changes
// through one long-lived process (streamLines); each burst re-reads
// the graph once (debounced).
//
// Note: the previous implementation counted AstalWp video streams, but
// AstalWp tracks zero streams on some setups (libastal/WirePlumber
// tracking gap) and the mask silently never engaged.
//
// Fails closed: pw-dump missing, spawn failing or an update throwing
// => sharing.
//
// Over-masking is accepted: a camera grab (a call with the camera on)
// counts too. TODO: discriminate portal screencasts from v4l2 grabs
// via the link target if that ever bothers anyone.

const [sharing, setSharing] = createState(false)
export { sharing }

let debounce = 0
let monitor: Gio.Subprocess | null = null

async function evaluate() {
    try {
        const out = await execAsync(["pw-dump"])
        const matches = out.match(/"media\.class": "Stream\/Input\/Video"/g)
        setSharing((matches?.length ?? 0) > 0)
    } catch {
        setSharing(true) // fail closed
    }
}

// portal negotiation and teardown churn the graph; debounce so the
// mask doesn't flicker
function scheduleEvaluate() {
    if (debounce) return
    debounce = timeoutAdd("screenShare:debounce", GLib.PRIORITY_DEFAULT, 300, () => {
        debounce = 0
        evaluate()
        return GLib.SOURCE_REMOVE
    })
}

let started = false
// set by dispose(): force_exit makes the monitor's pending read finish
// with EOF, which fires the onExit callback — that fail-closed path
// must not run for a kill we ordered ourselves
let disposed = false

// started by the consumer (the Harvest panel pill): detection only runs
// when something actually masks on it
export function enable() {
    if (started) return
    started = true
    disposed = false
    // stderr silenced: pw-dump prints protocol noise during portal
    // churn (resource races), which would otherwise flood the shell log
    monitor = streamLines(
        ["pw-dump", "-m"],
        () => scheduleEvaluate(),
        () => {
            if (disposed) return
            // the monitor died: we can't know — fail closed
            setSharing(true)
        },
        true,
    )
    if (!monitor && !disposed) setSharing(true) // fail closed
}

// convention for lib modules with long-lived sources, even though the
// shell never calls it today: one place that tears everything down
export function dispose() {
    disposed = true
    if (debounce) {
        sourceRemove(debounce)
        debounce = 0
    }
    monitor?.force_exit()
    monitor = null
    started = false
}
