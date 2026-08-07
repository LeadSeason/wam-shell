import GdkPixbuf from "gi://GdkPixbuf?version=2.0"
import Gio from "gi://Gio?version=2.0"
import GLib from "gi://GLib?version=2.0"
import Soup from "gi://Soup?version=3.0"
import Config from "../config"
import { isFile } from "./utils"
import { writeFileAtomic } from "./atomicWrite"

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

// bumped when artCandidates learns a bigger size: the cache is keyed by
// url, so without this every track already seen would keep serving the
// small copy until the week-long TTL got round to it. The file NAME
// keeps the cover- prefix so pruneCache still collects the old ones.
const CACHE_GEN = "2"

function cachePath(url: string): string {
    const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, `${CACHE_GEN}:${url}`, -1)
    return `${Config.instanceCacheDir}/cover-${hash}`
}

/** the same art, biggest first, with the player's own url last.
 *
 *  Players hand over whatever thumbnail their notification popup
 *  wanted — 300px is typical. The quick settings backdrop is ~440
 *  logical px wide and the laptop panel runs at 1.25, so that art is
 *  upscaled past 3x and looks it. Where the cdn encodes the size in
 *  the url we can just ask for the large one instead.
 *
 *  Every rewrite is a guess (maxresdefault exists only when the
 *  uploader supplied a big enough source, and size tokens change over
 *  the years), so the original always stays on the list as the
 *  fallback rather than being replaced. */
export function artCandidates(url: string): string[] {
    const out: string[] = []
    const add = (u: string) => {
        if (u !== url && !out.includes(u)) out.push(u)
    }

    // youtube: .../vi/<id>/<name>.jpg. maxres is 1280 wide but 404s on
    // plenty of videos, sd (640) is the safe second try
    const yt = url.match(
        /^(https?:\/\/[^/]*(?:ytimg|youtube)\.com\/vi(?:_webp)?\/[^/]+\/)[^/?#]+(\.\w+)([?#].*)?$/,
    )
    if (yt) {
        const [, base, ext, query = ""] = yt
        for (const n of ["maxresdefault", "sddefault", "hqdefault"])
            add(`${base}${n}${ext}${query}`)
    }

    // spotify: the 8 hex digits after ab67616d are the size class —
    // 00004851 is 64px, 00001e02 300px, 0000b273 640px
    add(url.replace(/^(https?:\/\/i\.scdn\.co\/image\/ab67616d)[0-9a-f]{8}/, "$10000b273"))

    // apple music: the thumb service renders any .../<w>x<h>bb.jpg
    if (url.includes("mzstatic.com/")) add(url.replace(/\/\d+x\d+(\w*\.\w+)$/, "/1000x1000$1"))

    // deezer, same idea: /<w>x<h>-000000-80-0-0.jpg
    if (url.includes("dzcdn.net/")) add(url.replace(/\/\d+x\d+-/, "/1000x1000-"))

    // last.fm: dropping the /64s/ /174s/ size segment serves the
    // original upload
    add(url.replace(/^(https?:\/\/[^/]*lastfm[^/]*\/i\/u\/)[^/]+\//, "$1"))

    // cover art archive: <n>-250.jpg and <n>-500.jpg are thumbnails
    if (url.includes("coverartarchive.org/")) add(url.replace(/-(?:250|500)(\.\w+)$/, "-1200$1"))

    out.push(url)
    return out
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
                // reject on a declared oversized body before finishing;
                // the read itself is still fully buffered, so the byte
                // check below stays as the actual enforcement
                const declared = Number(msg.get_response_headers().get_one("Content-Length")) || 0
                if (declared > MAX_COVER_BYTES)
                    throw new Error(`cover too large (${declared} bytes declared): ${url}`)
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

// try each candidate until one comes back an image. The list always
// ends with the url the player gave us, so a cdn that has stopped
// speaking our size tokens still lands on the art it does have.
function fetchLargest(urls: string[]): Promise<Uint8Array> {
    return fetchCover(urls[0]).catch(e => {
        if (urls.length === 1) throw e
        return fetchLargest(urls.slice(1))
    })
}

/** download url into the cover cache; resolves the cached path.
 *  The write is tmp+rename atomic (writeFileAtomic): a killed download
 *  must not leave a truncated file behind that the cache then treats
 *  as valid forever. Cached under the url the PLAYER reported, not the
 *  candidate that won: which rewrite succeeds must not change where a
 *  track's art lives, or the next play re-downloads it. */
export function downloadCover(url: string): Promise<string> {
    const path = cachePath(url)
    if (isFile(path)) return Promise.resolve(path)
    const pending = inFlight.get(url)
    if (pending) return pending
    const promise = fetchLargest(artCandidates(url))
        .then(data => writeFileAtomic(path, data).then(() => path))
        .finally(() => inFlight.delete(url))
    inFlight.set(url, promise)
    return promise
}

// the quick settings backdrop is ~440 logical px wide, and the laptop
// panel runs at 1.25 — under this the art is being upscaled hard enough
// to see, and no rewrite or lookup found anything better
const SHARP_MIN_WIDTH = 400

/** true when this cover is too small for the backdrop to show sharp.
 *  get_file_info reads the header only: no decode, no texture. */
export function isSmallCover(uri: string): boolean {
    if (!uri.startsWith("file://")) return false
    try {
        const [format, width] = GdkPixbuf.Pixbuf.get_file_info(uri.slice(7))
        return format !== null && width > 0 && width < SHARP_MIN_WIDTH
    } catch {
        return false
    }
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
// keyed by url hash, so stale entries (and leftover tmp files) would
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
