import Gio from "gi://Gio?version=2.0"
import GLib from "gi://GLib?version=2.0"
import Gst from "gi://Gst?version=1.0"
import GdkPixbuf from "gi://GdkPixbuf?version=2.0"
import Config from "../config"
import { isFile } from "./utils"
import { writeFileAtomic } from "./atomicWrite"
import { sourceRemove, timeoutAdd } from "./metrics"

// Full-size embedded cover art, for players whose published mpris art is
// a deliberate thumbnail: Telegram encodes its 320px song thumbnail as a
// data: url, so the http upgrade pipeline in coverArt has no bigger copy
// to ask a cdn for. When the track metadata still names the source file
// (xesam:url), the embedded image can be pulled from the file itself, at
// whatever size the tag actually holds.
//
// GStreamer does the tag parsing. Two GJS traps shape the pipeline:
// Discoverer's async mode dispatches its signals from its own worker
// thread, which gjs refuses to enter, and uridecodebin's pad-added fires
// on a streaming thread — same refusal. playbin links its sinks in C
// (passed as properties, no JS callbacks) and the tag messages arrive on
// a bus watch, which runs on the main context. Blocking discover_uri
// works but sits on the loop for the parse; this stays fully async.

// a tag message without an image starts the give-up clock — the embedded
// art usually rides in the FIRST tag batch, so if it was not there it is
// not coming. the hard cap covers demuxers that stall before preroll.
const GRACE_MS = 400
const HARD_TIMEOUT_MS = 5000

let gstReady = false
function ensureGst() {
    if (gstReady) return
    // gjs insists on the argv argument at runtime even though the gir
    // marks it optional
    Gst.init_check([])
    gstReady = true
}

/** decode the embedded image tag of the file at uri. Rejects when the
 *  file cannot be typefound/parsed or holds no image tag. */
function extractEmbeddedArt(uri: string): Promise<Uint8Array> {
    ensureGst()
    return new Promise((resolve, reject) => {
        const pipeline = Gst.ElementFactory.make("playbin", null)
        const audioSink = Gst.ElementFactory.make("fakesink", null)
        const videoSink = Gst.ElementFactory.make("fakesink", null)
        if (!pipeline || !audioSink || !videoSink)
            return reject(new Error("gstreamer elements unavailable"))
        // sync=false: preroll a single buffer and stop — we only want the
        // tags, not the audio
        audioSink.set_property("sync", false)
        videoSink.set_property("sync", false)
        pipeline.set_property("uri", uri)
        pipeline.set_property("audio-sink", audioSink)
        pipeline.set_property("video-sink", videoSink)

        let settled = false
        let preview: Uint8Array | null = null
        let graceTimer = 0
        let hardTimer = 0
        const settle = (bytes: Uint8Array | null, err?: Error) => {
            if (settled) return
            settled = true
            if (graceTimer) sourceRemove(graceTimer)
            if (hardTimer) sourceRemove(hardTimer)
            pipeline.set_state(Gst.State.NULL)
            if (bytes) resolve(bytes)
            else reject(err ?? new Error("no embedded art"))
        }
        // demuxers that found nothing to say give up shortly after their
        // first tag batch; an empty pipeline (no tags at all) holds the
        // hard timer instead
        const armGrace = () => {
            if (graceTimer || settled) return
            graceTimer = timeoutAdd("embeddedArt:grace", GLib.PRIORITY_DEFAULT, GRACE_MS, () => {
                graceTimer = 0
                settle(preview)
                return GLib.SOURCE_REMOVE
            })
        }
        hardTimer = timeoutAdd(
            "embeddedArt:timeout",
            GLib.PRIORITY_DEFAULT,
            HARD_TIMEOUT_MS,
            () => {
                hardTimer = 0
                settle(null, new Error("timed out reading tags"))
                return GLib.SOURCE_REMOVE
            },
        )

        const bus = pipeline.get_bus()
        if (!bus) return settle(null, new Error("no pipeline bus"))
        bus.add_watch(GLib.PRIORITY_DEFAULT, (_b, msg) => {
            if (settled) return GLib.SOURCE_REMOVE
            if (msg.type === Gst.MessageType.TAG) {
                const list = msg.parse_tag()
                // full-size cover first; a preview image only ever fills
                // in when no full cover arrived before the grace runs out
                const full = sampleBytes(list, "image")
                if (full) {
                    settle(full)
                    return GLib.SOURCE_REMOVE
                }
                preview ??= sampleBytes(list, "preview-image")
                armGrace()
            } else if (msg.type === Gst.MessageType.ERROR) {
                const [err] = msg.parse_error()
                settle(null, new Error(err ? err.message : "gstreamer error"))
                return GLib.SOURCE_REMOVE
            } else if (msg.type === Gst.MessageType.EOS) {
                settle(preview)
                return GLib.SOURCE_REMOVE
            }
            return GLib.SOURCE_CONTINUE
        })

        pipeline.set_state(Gst.State.PAUSED)
    })
}

// GST_TAG_IMAGE / GST_TAG_PREVIEW_IMAGE as sample values; null when the
// tag is absent or unmapped
function sampleBytes(list: Gst.TagList, tag: string): Uint8Array | null {
    if (list.get_tag_size(tag) === 0) return null
    const [ok, sample] = list.get_sample(tag)
    if (!ok || !sample) return null
    const buffer = sample.get_buffer()
    if (!buffer) return null
    const [mapped, map] = buffer.map(Gst.MapFlags.READ)
    if (!mapped) return null
    const bytes = map.data.slice(0, map.size)
    buffer.unmap(map)
    return bytes
}

/** pixel width of an image file, 0 when it cannot be read (header only,
 *  same trick as isSmallCover in coverArt) */
function imageWidth(uri: string): number {
    if (!uri.startsWith("file://")) return 0
    try {
        const [format, width] = GdkPixbuf.Pixbuf.get_file_info(uri.slice(7))
        return format !== null && width > 0 ? width : 0
    } catch {
        return 0
    }
}

function fileMtime(uri: string): number | null {
    try {
        const info = Gio.File.new_for_uri(uri).query_info(
            "time::modified",
            Gio.FileQueryInfoFlags.NONE,
            null,
        )
        return info ? info.get_attribute_uint64("time::modified") : null
    } catch {
        return null
    }
}

// mtime rides the key: a retagged file must re-extract, not serve last
// session's art for a week. same cover- prefix as coverArt so the weekly
// prune there collects these too
export function embeddedArtCachePath(trackUrl: string, mtime: number): string {
    const hash = GLib.compute_checksum_for_string(
        GLib.ChecksumType.MD5,
        `1:${trackUrl}:${mtime}`,
        -1,
    )
    return `${Config.instanceCacheDir}/cover-embed-${hash}`
}

// concurrent extractions of the same file share one promise; a failed
// extraction is remembered for the session so notify storms do not
// re-parse a tagless file (coverState only asks when the art on screen is
// small, so a success is self-extinguishing — the next check sees big art)
const inFlight = new Map<string, Promise<string>>()
const failed = new Set<string>()

/** replace a small on-screen cover with the track file's embedded art
 *  when the latter is bigger. currentUri and trackUrl are file:// uris;
 *  resolves the better cover's LOCAL PATH (no scheme), "" when the
 *  current art should stay. */
export function upgradeSmallCover(currentUri: string, trackUrl: string): Promise<string> {
    if (!trackUrl.startsWith("file://") || !currentUri.startsWith("file://"))
        return Promise.resolve("")
    if (!isFile(currentUri.slice(7))) return Promise.resolve("")
    const mtime = fileMtime(trackUrl)
    if (mtime === null) return Promise.resolve("")
    const path = embeddedArtCachePath(trackUrl, mtime)
    const currentWidth = imageWidth(currentUri)
    if (isFile(path)) {
        const width = imageWidth(`file://${path}`)
        return Promise.resolve(width > currentWidth ? path : "")
    }
    if (failed.has(path)) return Promise.resolve("")
    const pending = inFlight.get(path)
    const extracting =
        pending ??
        extractEmbeddedArt(trackUrl)
            .then(bytes => writeFileAtomic(path, bytes).then(() => path))
            .finally(() => inFlight.delete(path))
    if (!pending) inFlight.set(path, extracting)
    return extracting.then(
        written => {
            const width = imageWidth(`file://${written}`)
            return width > currentWidth ? written : ""
        },
        () => {
            failed.add(path)
            return ""
        },
    )
}
