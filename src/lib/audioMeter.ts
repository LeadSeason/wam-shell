import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import AstalWp from "gi://AstalWp?version=0.1"
import { Accessor, createState } from "gnim"
import { streamLines } from "./streamLines"
import { connect, disconnect } from "./metrics"

// Level meters for the default output and the default input.
//
// AstalWp exposes no peak, rms or level property — a node reports its
// volume, never its current amplitude — so reading a level means
// becoming a capture client, the same thing pavucontrol and pwvucontrol
// do. One gstreamer pipeline per direction covers everything: the
// output meter reads the sink's monitor, which is every application
// mixed together, so no per-app pipelines are needed.
//
// Nothing runs unless a holder asks for it (acquire), and the only
// holders are the two audio panes while they are on screen. That matters
// most for the input meter, which really does open the microphone: it is
// live only while you are looking at the Input pane.

// identifies our own capture streams so the panes can keep them out of
// their lists — the input meter records the microphone, and would
// otherwise be listed, by us, as an app recording you
export const METER_CLIENT = "wam-shell-meter"

// the meters' floor. Everyday content sits around -30..-10 dBFS, so a
// -60 floor keeps the interesting range in the upper half of the bar
// while still showing that something quiet is there
const FLOOR_DB = 60
// how often the level element posts, in nanoseconds. 50ms reads as
// continuous; the cost is one short line to parse 20 times a second
const INTERVAL_NS = 50_000_000

// no gstreamer, no meter: the panes just never draw the bar rather than
// spawning a process that cannot exist
export const meterSupported = GLib.find_program_in_path("gst-launch-1.0") !== null

// "decay=(GValueArray)< -17.32, -17.29 >" — the level element posts
// rms, peak and decay (peak with a falloff) per channel.
//
// The two directions want different ones, which is measured, not taste:
//
// - Output uses decay. It answers "is this about to clip", so it has to
//   follow transients, and a falloff keeps it readable.
// - Input uses rms. Decay on a real microphone is pinned: this laptop's
//   internal mic reports decay ABOVE 0 dBFS (+2.3, +1.7, +1.2) on an
//   empty room from its own self-noise, so a peak bar sits full and red
//   forever and says nothing. Its rms over the same seconds moved
//   between -12 and -25 dB, which is the "is my voice getting through"
//   the input bar is actually for.
const DECAY = /decay=\(GValueArray\)<([^>]*)>/
const RMS = /rms=\(GValueArray\)<([^>]*)>/

export interface Meter {
    /** the current level, 0 to 1, or a flat 0 while no one holds it */
    level: Accessor<number>
    /** start metering; call the returned function to release. Reference
     *  counted, so overlapping holders share one pipeline */
    acquire(): () => void
}

function createMeter(direction: "output" | "input"): Meter {
    const isOutput = direction === "output"
    const [level, setLevel] = createState(0)
    let proc: Gio.Subprocess | null = null
    let defaultHandler: number | null = null
    let holders = 0

    const endpoint = () => {
        const wp = AstalWp.get_default()?.audio
        return (isOutput ? wp?.defaultSpeaker : wp?.defaultMicrophone) ?? null
    }

    /**
     * What the node's own volume adds to what the pipeline hears.
     *
     * The two directions genuinely differ, both measured rather than
     * assumed:
     *
     * - A sink's monitor is tapped BEFORE the volume stage. A
     *   0.2-amplitude tone reads -13.98 dBFS with the sink at 55% and at
     *   100% alike, so the raw level is the material's own loudness and
     *   would sit still while the slider above it moves. The gain is
     *   applied here to get what the speakers are actually asked to
     *   produce, which is the number worth comparing to that slider.
     *
     * - A source capture is already post-volume: the same room, read at
     *   51% and at 100% mic volume, differed by about 15 dB on its own.
     *   Applying the gain there would count it twice.
     *
     * The curve is the cube of the volume, which is what pulse and
     * wireplumber use for their percentages (55% -> -15.58 dB = 0.55^3).
     */
    function gainDb(): number {
        const ep = endpoint()
        // a muted node reads empty, whichever direction it is
        if (!ep || ep.mute) return -Infinity
        if (!isOutput) return 0
        return ep.volume > 0 ? 60 * Math.log10(ep.volume) : -Infinity
    }

    const metric = isOutput ? DECAY : RMS

    function onLine(line: string) {
        const match = metric.exec(line)
        if (!match) return
        // the loudest channel: a meter is asking "is this too hot", and
        // one clipping channel is enough for that to be true
        let top = -Infinity
        for (const part of match[1].split(",")) {
            const db = Number.parseFloat(part)
            // silence reports -inf, which parses to -Infinity and loses
            if (Number.isFinite(db) && db > top) top = db
        }
        const db = top + gainDb()
        setLevel(Number.isFinite(db) ? Math.min(1, Math.max(0, (db + FLOOR_DB) / FLOOR_DB)) : 0)
    }

    function stop() {
        proc?.force_exit()
        proc = null
        setLevel(0)
    }

    function start() {
        stop()
        // by node id, not by name: astal reports name = null on every
        // endpoint (description is all it fills in), so there is no
        // device name to hand pulsesrc. The id IS the pipewire node id,
        // which pipewiresrc takes directly
        const id = endpoint()?.id
        if (!id) return
        // a sink is an output; without this pipewiresrc would try to read
        // it as a capture device and get nothing. A source needs no such
        // hint, it is already something to read from
        // every name gstreamer would otherwise fill in with its own
        // binary. astal labels a stream from node.description, so
        // setting only node.name left our capture listed as
        // "gst-launch-1.0" in the pane's own Recording list — checked
        // against pw-dump, which is where the remaining two come from
        const props = [
            "props",
            `node.name=${METER_CLIENT}`,
            `node.description=${METER_CLIENT}`,
            `media.name=${METER_CLIENT}`,
            `application.name=${METER_CLIENT}`,
        ]
        if (isOutput) props.push("stream.capture.sink=true")
        proc = streamLines(
            [
                "gst-launch-1.0",
                "-m",
                "pipewiresrc",
                `target-object=${id}`,
                `stream-properties=${props.join(",")}`,
                "!",
                "audioconvert",
                "!",
                "level",
                `interval=${INTERVAL_NS}`,
                "!",
                "fakesink",
                "sync=false",
            ],
            onLine,
            () => {
                // the pipeline died on its own (the device vanished
                // mid-read). Leave the bar empty; the next default change
                // or the next acquire starts a fresh one
                proc = null
                setLevel(0)
            },
            true,
        )
    }

    return {
        level,
        acquire() {
            if (!meterSupported) return () => {}

            if (++holders === 1) {
                start()
                // the pipeline is bound to one specific node: switching
                // the default has to move it, or the bar keeps showing a
                // device that is no longer being used
                const wp = AstalWp.get_default()?.audio
                const signal = isOutput ? "notify::default-speaker" : "notify::default-microphone"
                if (wp) defaultHandler = connect(wp, signal, () => start())
            }

            let released = false
            return () => {
                if (released) return
                released = true
                if (--holders > 0) return
                const wp = AstalWp.get_default()?.audio
                if (wp && defaultHandler !== null) disconnect(wp, defaultHandler)
                defaultHandler = null
                stop()
            }
        },
    }
}

/** the default sink's level: post-mix and, after compensation, the
 *  level the speakers are being asked to produce */
export const outputMeter = createMeter("output")
/** the default source's level. Holding this opens the microphone */
export const inputMeter = createMeter("input")
