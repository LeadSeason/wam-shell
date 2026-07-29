import GLib from "gi://GLib?version=2.0"
import { execAsync } from "ags/process"
import Config from "../config"
import { isFile } from "./utils"

// Synchronous local path for mpris cover art. http(s) art is downloaded
// once into the cache dir — the next track change uses the cached copy.
// Returns "" when nothing is available yet.

// dedup concurrent downloads of the same url
const inFlight = new Set<string>()

function cachePath(url: string): string {
    const hash = GLib.compute_checksum_for_string(
        GLib.ChecksumType.MD5, url, -1)
    return `${Config.instanceCacheDir}/cover-${hash}`
}

/** download url into the cover cache; resolves the cached path.
 *  Writes to a .part file first: a killed download must not leave a
 *  truncated file behind that the cache then treats as valid forever. */
export function downloadCover(url: string): Promise<string> {
    const path = cachePath(url)
    if (isFile(path)) return Promise.resolve(path)
    if (inFlight.has(url)) {
        // piggyback: report failure to the caller, the first download
        // populates the cache for the next lookup
        return Promise.reject(new Error("download already in flight"))
    }
    inFlight.add(url)
    const part = `${path}.part`
    return execAsync(["curl", "-sL", "--fail", "--max-time", "10", url, "-o", part])
        .then(() => {
            GLib.rename(part, path)
            return path
        })
        .catch((e) => {
            GLib.unlink(part)
            throw e
        })
        .finally(() => inFlight.delete(url))
}

export function coverFile(url: string): string {
    if (!url) return ""
    // astal gives bare paths (no file:// scheme) for local art
    if (url.startsWith("/")) return isFile(url) ? `file://${url}` : ""
    if (!url.startsWith("http")) return url

    const path = cachePath(url)
    if (isFile(path)) return `file://${path}`
    downloadCover(url).catch(() => { })
    return ""
}
