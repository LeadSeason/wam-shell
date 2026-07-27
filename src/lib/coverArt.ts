import GLib from "gi://GLib?version=2.0"
import { execAsync } from "ags/process"
import Config from "../config"
import { isFile } from "./utils"

// Synchronous local path for mpris cover art. http(s) art is downloaded
// once into the cache dir — the next track change uses the cached copy.
// Returns "" when nothing is available yet.
export function coverFile(url: string): string {
    if (!url) return ""
    // astal gives bare paths (no file:// scheme) for local art
    if (url.startsWith("/")) return isFile(url) ? `file://${url}` : ""
    if (!url.startsWith("http")) return url

    const hash = GLib.compute_checksum_for_string(
        GLib.ChecksumType.MD5, url, -1)
    const path = `${Config.instanceCacheDir}/cover-${hash}`
    if (isFile(path)) return `file://${path}`
    execAsync(["curl", "-sL", "--fail", url, "-o", path]).catch(() => { })
    return ""
}
