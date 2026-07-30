import GLib from "gi://GLib?version=2.0"
import AstalWp from "gi://AstalWp?version=0.1"
import { createState } from "gnim"

// Screen-share detection, signal-driven through WirePlumber. A video
// PRODUCER stream means a capture is active (portal screencast always
// creates one, verified by a local gst spike); consumers (webcam
// grabbers) land in the recorders list and do NOT count, and cameras
// are devices, never streams — so joining a call with the camera on is
// not a share.
//
// Fails closed: AstalWp missing or an update throwing => sharing.

const [sharing, setSharing] = createState(false)
export { sharing }

// TODO: name-based discrimination of benign producers (OBS virtual
// camera) needs a calibration pass against a real share; until then
// every producer counts — over-masking is the safe side for privacy.

let debounce = 0

function evaluate() {
    try {
        const video = AstalWp.get_default()?.video
        if (!video) return setSharing(true) // fail closed
        setSharing((video.get_streams() ?? []).length > 0)
    } catch {
        setSharing(true) // fail closed
    }
}

// the portal churns nodes during negotiation and teardown; debounce so
// the mask doesn't flicker
function scheduleEvaluate() {
    if (debounce) return
    debounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
        debounce = 0
        evaluate()
        return GLib.SOURCE_REMOVE
    })
}

let started = false

// started by the consumer (the Harvest panel pill): detection only runs
// when something actually masks on it
export function enable() {
    if (started) return
    started = true
    const video = AstalWp.get_default()?.video
    if (video) {
        video.connect("notify::streams", scheduleEvaluate)
        evaluate()
    } else {
        setSharing(true) // fail closed
    }
}
