import Gio from "gi://Gio?version=2.0"
import GLib from "gi://GLib?version=2.0"
import Soup from "gi://Soup?version=3.0"
import Config from "../config"
import { isFile } from "./utils"

// Synchronous local path for mpris cover art. http(s) art is downloaded
// once into the cache dir — the next track change uses the cached copy.
// Returns "" when nothing is available yet.

// concurrent downloads of the same url share one promise: a second
// caller rides the in-flight download instead of being rejected for
// something that will succeed a moment later
const inFlight = new Map<string, Promise<string>>()

// send_and_read buffers the whole body: cap it so a bogus "cover" url
// can't balloon memory, and reject non-image payloads outright
const MAX_COVER_BYTES = 10 * 1024 * 1024
const session = new Soup.Session({ timeout: 10 })

function cachePath(url: string): string {
    const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, url, -1)
    return `${Config.instanceCacheDir}/cover-${hash}`
}

function fetchCover(url: string): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        const msg = Soup.Message.new("GET", url)
        if (!msg) return reject(new Error(`invalid cover url: ${url}`))
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (_s, res) => {
            try {
                const status = msg.get_status()
                if (status < 200 || status >= 300) throw new Error(`http ${status}: ${url}`)
                const type = msg.get_response_headers().get_one("Content-Type") ?? ""
                if (!type.startsWith("image/"))
                    throw new Error(`not an image (${type || "no content-type"}): ${url}`)
                const data = session.send_and_read_finish(res)?.get_data()
                if (!data || data.length === 0) throw new Error(`empty response: ${url}`)
                if (data.length > MAX_COVER_BYTES)
                    throw new Error(`cover too large (${data.length} bytes): ${url}`)
                resolve(data)
            } catch (e) {
                reject(e)
            }
        })
    })
}

/** download url into the cover cache; resolves the cached path.
 *  Writes to a .part file first: a killed download must not leave a
 *  truncated file behind that the cache then treats as valid forever. */
export function downloadCover(url: string): Promise<string> {
    const path = cachePath(url)
    if (isFile(path)) return Promise.resolve(path)
    const pending = inFlight.get(url)
    if (pending) return pending
    const part = `${path}.part`
    const promise = fetchCover(url)
        .then(data => {
            GLib.file_set_contents(part, data)
            GLib.rename(part, path)
            return path
        })
        .catch(e => {
            GLib.unlink(part)
            throw e
        })
        .finally(() => inFlight.delete(url))
    inFlight.set(url, promise)
    return promise
}

export function coverFile(url: string): string {
    if (!url) return ""
    // astal gives bare paths (no file:// scheme) for local art
    if (url.startsWith("/")) return isFile(url) ? `file://${url}` : ""
    if (!url.startsWith("http")) return url

    const path = cachePath(url)
    if (isFile(path)) return `file://${path}`
    downloadCover(url).catch(() => {})
    return ""
}

// prune cached covers older than a week once at startup: the cache is
// keyed by url hash, so stale entries (and leftover .part files) would
// otherwise accumulate forever
const COVER_TTL_SEC = 7 * 24 * 60 * 60
function pruneCache() {
    const dir = Gio.File.new_for_path(Config.instanceCacheDir)
    dir.enumerate_children_async(
        "standard::name,time::modified",
        Gio.FileQueryInfoFlags.NONE,
        GLib.PRIORITY_LOW,
        null,
        (_d, res) => {
            try {
                const iter = dir.enumerate_children_finish(res)
                const cutoff = GLib.get_real_time() / 1_000_000 - COVER_TTL_SEC
                let info: Gio.FileInfo | null
                while ((info = iter.next_file(null)) !== null) {
                    const name = info.get_name()
                    if (!name.startsWith("cover-")) continue
                    if (info.get_attribute_uint64("time::modified") > cutoff) continue
                    GLib.unlink(`${Config.instanceCacheDir}/${name}`)
                }
            } catch {
                /* no cache dir yet: nothing to prune */
            }
        },
    )
}
pruneCache()
