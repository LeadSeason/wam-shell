import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import Gst from "gi://Gst?version=1.0"
import Config from "../config"
import { execAsync, timeoutAdd, sourceRemove } from "./metrics"
import { registerDispose } from "./lifecycle"

// Audible feedback for volume changes: each time the volume pill
// presents with a real level, play the sound theme's short
// "volume changed" click, so a level driven with the keyboard can be
// heard as well as watched. The click plays through the default sink at
// the stream's own volume, so the sink level itself scales it — the
// ramp gets louder as the level rises, which is most of the
// information. Muted frames never reach here (osd.ts holds them back):
// the click would only play into a muted sink.
//
// Playback is ONE live in-process GStreamer pipeline (appsrc !
// audioconvert ! pulsesink) that the sample is pushed into per click,
// and the shape is forced by measurement, not taste. The click is 67ms
// long; a per-click player (paplay ~70ms, canberra-gtk-play ~150ms
// before its first sample) either lags the key or, throttled, dies
// before it sounds. Re-firing one playbin with a FLUSH seek is instant
// in the pipeline, but on a Bluetooth sink the re-seeked audio never
// reaches the server — recorded: the stream tap carries garbage after
// the first click, while a continuously-fed appsrc stream (the same
// path music uses) delivered every click, peak-exact, six for six. So:
// the sample is decoded to raw PCM once (gst-launch, one shot at the
// first click, off the audible path), and a click is one
// `push-buffer` — microseconds. Until the decode lands (and forever,
// if it can't), clicks fall back to a per-click subprocess player.
//
// Deliberately NOT played for the microphone pill: a mic change has no
// audible reference level to confirm.

const EVENT = "audio-volume-change"

const SOUND_CANDIDATES = ["/usr/share/sounds/freedesktop/stereo/audio-volume-change.oga"]

// one stat at import decides whether the decode can exist at all
const nativeFile = SOUND_CANDIDATES.find(p => GLib.file_test(p, GLib.FileTest.EXISTS)) ?? null

// ------------------------------------------------- live appsrc stream

// the decoded sample (S16LE 48kHz stereo) and its pipeline
let pcm: Uint8Array | null = null
let decoding = false
let decodeFailed = false

let pipeline: Gst.Element | null = null
let appsrc: Gst.Element | null = null
let bus: Gst.Bus | null = null
// two pipeline errors (device gone mid-play and it does not come back)
// retire the native path for the session; one error gets one rebuild,
// which is how a sink hotplug recovers without a shell restart
let nativeErrors = 0
let nativeFailed = false
// setup trouble is worth one line, once — a per-click warn would spam
// exactly when ramping
let warned = false

function teardownPipeline() {
    if (pipeline === null) return
    pipeline.set_state(Gst.State.NULL)
    bus?.remove_signal_watch()
    bus = null
    appsrc = null
    pipeline = null
}

function ensurePipeline(): boolean {
    if (pipeline !== null) return true
    if (nativeFailed || nativeFile === null) return false
    try {
        // GJS's gi typings want `undefined` here; null works at runtime
        Gst.init(undefined)
        const p = Gst.ElementFactory.make("pipeline", "wamVolumeFeedback") as Gst.Bin
        const s = Gst.ElementFactory.make("appsrc", "src")
        const c = Gst.ElementFactory.make("audioconvert", "conv")
        const k = Gst.ElementFactory.make("pulsesink", "sink")
        if (!p || !s || !c || !k) throw new Error("GStreamer elements unavailable")
        s.set_property(
            "caps",
            Gst.Caps.from_string(
                "audio/x-raw,format=S16LE,layout=interleaved,rate=48000,channels=2",
            ),
        )
        // live + do-timestamp: each push is stamped now, no clock wrangling
        s.set_property("is-live", true)
        s.set_property("do-timestamp", true)
        s.set_property("format", Gst.Format.TIME)
        k.set_property("volume", 1.0)
        p.add(s)
        p.add(c)
        p.add(k)
        s.link(c)
        c.link(k)
        // go live immediately: the stream opens with the first push and
        // stays connected between clicks — without this the pushes land
        // in a NULL pipeline, queue silently and never play (which is
        // exactly the "no sound at all" this line fixed)
        p.set_state(Gst.State.PLAYING)
        const b = p.get_bus()
        if (b === null) throw new Error("pipeline has no bus")
        b.add_signal_watch()
        b.connect("message::error", () => {
            nativeErrors++
            teardownPipeline()
            if (nativeErrors >= 2) nativeFailed = true
            if (!warned) {
                warned = true
                console.warn(
                    "volumeFeedback: gstreamer sink error, " +
                        (nativeFailed
                            ? "falling back to a subprocess player for the session"
                            : "rebuilding the pipeline on the next click"),
                )
            }
        })
        pipeline = p
        appsrc = s
        bus = b
        return true
    } catch (e) {
        nativeFailed = true
        console.warn("volumeFeedback: gstreamer unavailable, subprocess fallback:", e)
        return false
    }
}

function makeBuffer(): Gst.Buffer {
    // new_memdup COPIES; new_wrapped on a JS Uint8Array dangles — its
    // content was verified corrupt mid-playback, so never "simplify"
    // this back
    return Gst.Buffer.new_memdup(pcm as Uint8Array)
}

function pushPcm(): boolean {
    if (!ensurePipeline() || appsrc === null) return false
    // push-buffer is an action signal; the gi typings type its return
    // as void even though it carries the FlowReturn at runtime
    const flow = appsrc.emit("push-buffer", makeBuffer()) as unknown as Gst.FlowReturn
    return flow === Gst.FlowReturn.OK
}

// ------------------------------------------------- one-shot decode

function canDecode(): boolean {
    return nativeFile !== null && GLib.find_program_in_path("gst-launch-1.0") !== null
}

// linear gain on interleaved S16LE data, clamped to int16. The theme
// click peaks around 0.14 (float), so the gains anyone would ask for
// never actually clip — the clamp is for the extremes the config allows
function applyGain(data: Uint8Array, gain: number) {
    if (gain === 1) return
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    for (let o = 0; o + 1 < data.byteLength; o += 2) {
        view.setInt16(
            o,
            Math.max(-32768, Math.min(32767, Math.round(view.getInt16(o, true) * gain))),
            true,
        )
    }
}

// file -> raw PCM on disk -> memory. Runs while the first click already
// sounds through the fallback player, so the decode is never on the
// audible path.
function startDecode() {
    decoding = true
    const uri = GLib.filename_to_uri(nativeFile as string, null)
    // XDG_RUNTIME_DIR: per-user tmpfs, no collision or PID juggling
    const tmp = `${GLib.get_user_runtime_dir()}/wam-shell-volume-feedback.pcm`
    execAsync([
        "gst-launch-1.0",
        "-q",
        "uridecodebin",
        `uri=${uri}`,
        "!",
        "audioconvert",
        "!",
        "audioresample",
        "!",
        "capsfilter",
        "caps=audio/x-raw,format=S16LE,layout=interleaved,rate=48000,channels=2",
        "!",
        "filesink",
        `location=${tmp}`,
    ])
        .then(() => {
            const [ok, bytes] = GLib.file_get_contents(tmp)
            GLib.unlink(tmp)
            // a truncated decode would click wrong forever; fall back
            // instead (the freedesktop click is ~12.8KB at this format)
            pcm = ok && bytes.byteLength > 1000 ? bytes : null
            if (pcm === null) {
                decodeFailed = true
            } else {
                applyGain(pcm, Config.osd.feedbackVolume)
            }
        })
        .catch(e => {
            GLib.file_test(tmp, GLib.FileTest.EXISTS) && GLib.unlink(tmp)
            decodeFailed = true
            console.warn("volumeFeedback: decode failed, subprocess fallback stays:", e)
        })
        .finally(() => {
            decoding = false
        })
}

// ------------------------------------------------- subprocess fallback

// also the first-click player (the decode is never on the audible
// path) and the whole feature on systems without GStreamer.
// pw-play/paplay lead on latency; canberra, which resolves the event
// through the user's sound theme, only gets a look in when the
// freedesktop file is missing. The gain rides along where a player can
// express it: paplay takes a linear factor (65536 = 100%), canberra
// takes dB, pw-play/ffplay cannot boost at all — so with gain above 1
// paplay is preferred over pw-play and the first click still matches
// the boosted ones
function resolveFallback(): string[] | null {
    const file = SOUND_CANDIDATES.find(p => GLib.file_test(p, GLib.FileTest.EXISTS))
    const gain = Config.osd.feedbackVolume
    if (file) {
        const order = gain > 1 ? ["paplay", "pw-play"] : ["pw-play", "paplay"]
        const player = [...order, "ffplay"].find(p => GLib.find_program_in_path(p) !== null)
        if (player === undefined) {
            // fall through to canberra
        } else if (player === "paplay") {
            return [player, "--volume", String(Math.round(gain * 65536)), file]
        } else if (player === "ffplay") {
            return [player, "-nodisp", "-autoexit", "-loglevel", "quiet", file] // -volume caps at 100, no boost to express
        } else {
            return [player, file]
        }
    }
    if (GLib.find_program_in_path("canberra-gtk-play") !== null)
        return ["canberra-gtk-play", "-V", (10 * Math.log10(gain || 0.001)).toFixed(2), "-i", EVENT]
    return null
}

// the most recent fallback player, kept so dispose() can stop a click
// that is mid-ring at shutdown
let proc: Gio.Subprocess | null = null

function spawnSubprocess(argv: string[]) {
    let p: Gio.Subprocess
    try {
        p = Gio.Subprocess.new(
            argv,
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
        )
    } catch (e) {
        console.warn("volumeFeedback:", e)
        return
    }
    proc = p
    p.wait_check_async(null, (_source, res) => {
        try {
            p.wait_check_finish(res)
        } catch (e) {
            // only a click that died on its own is news — warn once, it
            // is setup trouble, and a per-click warn would spam exactly
            // when ramping
            if (proc === p && !warned) {
                warned = true
                console.warn("volumeFeedback:", e)
            }
        }
        if (proc === p) proc = null
    })
}

// ------------------------------------------------- pacing

/**
 * The pacing decision, GTK-free so tests can drive it with a fake
 * clock: a click requested inside `minIntervalMs` of the previous one
 * is not dropped but folded onto ONE slot at the window's end, and that
 * slot is not pushed out by later events. A held volume key therefore
 * ticks at a fixed cadence instead of machine-gunning the player per
 * step, and every burst always ends on a full click of the final
 * level — the last swallowed event is the one the armed slot speaks
 * for, since the click's loudness comes from the sink, not from us.
 */
export class ClickPacer {
    private last = -Infinity // when the most recent click started
    private slot: number | null = null // when the armed trailing click fires

    constructor(readonly minIntervalMs: number) {}

    /** Feed it `Date.now()`; 0 = click now, >0 = click after this many ms. */
    request(now: number): number {
        const wait = this.last + this.minIntervalMs - now
        if (wait > 0) {
            this.slot = this.last + this.minIntervalMs
            return this.slot - now
        }
        this.fired(now)
        return 0
    }

    /** A click actually started at `now` (an immediate request lands
     *  here too, so the armed bookkeeping lives in one place). */
    fired(now: number) {
        this.last = now
        this.slot = null
    }

    /** Absolute time of the armed trailing click, null when none. */
    get pendingSlot(): number | null {
        return this.slot
    }

    reset() {
        this.last = -Infinity
        this.slot = null
    }
}

// the PCM push is effectively free, but the sound itself is 67ms and a
// continuous stream would blend ticks spaced under it; 100ms keeps
// them discrete and still reads as a live ramp
const MIN_INTERVAL_MS = 100

const pacer = new ClickPacer(MIN_INTERVAL_MS)

let trailing: number | null = null

// only disarms the source; the pacer's clock is untouched — an
// immediate click keeps its throttle window even when a slot was armed
function cancelTrailing() {
    if (trailing !== null) {
        sourceRemove(trailing)
        trailing = null
    }
}

function play() {
    if (pcm !== null && pushPcm()) return
    // no PCM yet (first clicks of the session) or it can never exist:
    // per-click player. The decode is kicked off here so it is never
    // on the audible path
    if (!decoding && !decodeFailed && canDecode()) startDecode()
    const argv = resolveFallback()
    if (argv !== null) spawnSubprocess(argv)
}

/**
 * Play the click for one presented volume pill. Safe to call for every
 * pill: disabled feedback, a missing player and the throttle window all
 * resolve to "nothing sounds", and none of them lose the burst's final
 * click (see ClickPacer).
 */
export function click() {
    if (!Config.osd.feedback) return
    if (nativeFile === null && resolveFallback() === null) return
    const delay = pacer.request(Date.now())
    if (delay > 0) {
        if (trailing !== null) return // already armed for the same slot
        trailing = timeoutAdd("volumeFeedback:trailing", GLib.PRIORITY_DEFAULT, delay, () => {
            trailing = null
            pacer.fired(Date.now())
            play()
            return GLib.SOURCE_REMOVE
        })
        return
    }
    // eligible now: the armed slot would double the click (a busy main
    // loop can let its deadline slip past this point)
    cancelTrailing()
    play()
}

export function dispose() {
    cancelTrailing()
    pacer.reset()
    teardownPipeline()
    proc?.force_exit()
    proc = null
}

registerDispose("volumeFeedback", dispose)
