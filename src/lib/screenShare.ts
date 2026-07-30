import GLib from "gi://GLib?version=2.0"
import AstalWp from "gi://AstalWp?version=0.1"
import { createState } from "gnim"
import Config from "../config"
import { timeoutAdd, connect } from "./metrics"

// Screen-share detection, signal-driven through WirePlumber. Generic
// (usable by any widget that wants privacy masking); currently consumed by
// the Harvest panel module.
//
// What counts, verified by a local spike (gjs + gst pipelines):
// - a video PRODUCER (videotestsrc ! pipewiresink) lands in get_streams()
// - a video CONSUMER (pipewiresrc ! fakesink, same shape as a webcam
//   grabber) lands in get_recorders() — so recorders>0 would over-trigger
//   on any video call with the camera on and is NOT the signal
// - a portal screencast always creates a producer stream, so
//   get_streams() is the signal
// Cameras are devices (sources), never streams, so a present-but-idle
// webcam does not count.
//
// Fails closed: AstalWp missing or an update throwing => sharing.

const [sharing, setSharing] = createState(false)
export { sharing }

// Producer names that should NOT count as sharing. gst test pipelines and
// similar benign producers land here; the calibration pass (a real portal
// share) decides whether portal nodes need name-based discrimination.
// Until then every producer stream counts: over-masking is the safe side
// for a privacy feature.
const BENIGN_PRODUCERS: RegExp[] = []

function countShares(): boolean {
    const video = AstalWp.get_default()?.video
    if (!video) return true // fail closed
    const streams = video.get_streams() ?? []
    return streams.some((s) => {
        const name = `${s.name ?? ""} ${s.description ?? ""}`
        return !BENIGN_PRODUCERS.some((re) => re.test(name))
    })
}

let debounce = 0

function evaluate() {
    try {
        setSharing(countShares())
    } catch {
        setSharing(true) // fail closed
    }
}

// the portal churns nodes during negotiation and teardown; debounce so
// the mask doesn't flicker
function scheduleEvaluate() {
    if (debounce) return
    debounce = timeoutAdd("screenShare:debounce", GLib.PRIORITY_DEFAULT, 300, () => {
        debounce = 0
        evaluate()
        return GLib.SOURCE_REMOVE
    })
}

if (Config.harvest.enabled && Config.harvest.maskWhenSharing) {
    const video = AstalWp.get_default()?.video
    if (video) {
        // only producer streams are the signal (recorders = any webcam
        // consumer, which would over-trigger)
        connect(video, "notify::streams", scheduleEvaluate)
        evaluate()
    } else {
        setSharing(true) // fail closed
    }
}
