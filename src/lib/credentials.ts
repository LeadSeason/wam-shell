import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { isFile } from "./utils"

// Shared credential loading for the service providers (Google, Harvest,
// GitHub, Todoist, ProtonMail): each reads its secrets from environment
// variables and/or a KEY=value env file in ~/.config/wam-shell. One
// canonical implementation of what every provider used to inline.
//
// Semantics:
// - per key, the environment variable wins over the file value (a key
//   set in both places resolves to the env var; unset/empty env vars
//   fall through to the file)
// - file syntax: `KEY=value` per line, optional `export ` prefix,
//   optional single/double quotes, `#` comments (full-line, or inline
//   when preceded by whitespace), surrounding whitespace ignored
// - a repeated key keeps its LAST value (shell `source` semantics)
// - a key with no value anywhere (or an empty one, e.g. `KEY=""`)
//   fails the whole load: null
// - missing/unreadable file: null
// - the file's permissions are checked (and warned about) only when
//   the file is actually read — a complete set of env vars never
//   touches it

// documented chmod 600 is advice; warn when group/other can read it
export function warnPerms(logTag: string, path: string): void {
    try {
        const info = Gio.File.new_for_path(path).query_info(
            "unix::mode",
            Gio.FileQueryInfoFlags.NONE,
            null,
        )
        const mode = info.get_attribute_uint32("unix::mode") & 0o777
        if (mode & 0o077) {
            console.warn(
                `${logTag}: ${path} is readable by group/other (mode ${mode.toString(8)}); consider chmod 600`,
            )
        }
    } catch (e) {
        console.warn(`${logTag}: could not stat file:`, e)
    }
}

// parse the requested KEY=value pairs out of an env file; null when the
// file is missing or unreadable. Keys absent from the file are absent
// from the result — an empty record means "readable, nothing matched".
export function loadEnvFile(path: string, keys: string[]): Record<string, string> | null {
    if (!isFile(path)) return null
    let text: string
    try {
        const contents = GLib.file_get_contents(path)[1]
        text = new TextDecoder().decode(contents)
    } catch (e) {
        console.warn(`credentials: failed reading ${path}:`, e)
        return null
    }
    const wanted = keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
    const line = new RegExp(`^\\s*(?:export\\s+)?(${wanted})\\s*=\\s*(.+?)\\s*$`)
    const out: Record<string, string> = {}
    for (const l of text.split("\n")) {
        const m = l.match(line)
        if (!m) continue
        // tolerate inline comments and single/double quotes
        out[m[1]] = m[2].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "")
    }
    return out
}

// resolve every key from the environment first and the env file second;
// null when any key ends up without a value
export function loadCredentials(
    logTag: string,
    envKeys: string[],
    filePath: string,
): Record<string, string> | null {
    const out: Record<string, string> = {}
    const missing: string[] = []
    for (const key of envKeys) {
        const value = GLib.getenv(key)
        if (value) out[key] = value
        else missing.push(key)
    }
    if (missing.length === 0) return out
    if (!isFile(filePath)) return null
    warnPerms(logTag, filePath)
    const fromFile = loadEnvFile(filePath, missing)
    if (!fromFile) return null
    for (const key of missing) {
        const value = fromFile[key]
        if (!value) return null
        out[key] = value
    }
    return out
}
