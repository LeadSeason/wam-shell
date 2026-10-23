// Headless config canonicalizer, run by `wam config format` — and by
// `wam config sync`, which is the same engine under a different name
// (both rewrite a config against the CURRENT template; #376).
//
// The engine lives in src/lib/configFormat — display-free and GJS-free,
// so the unit suite exercises it directly (tests/configFormat.test.ts)
// against the real template. This entry only resolves paths (env, set
// by cmd_config_format()/cmd_config_sync() in scripts/wam, which bundle
// this file on demand the way compile_style() bundles precompile-style.ts),
// applies the rails around the rewrite — a .bak of the original before
// anything replaces it, and "already canonical" is not a write — and
// reports. WAM_FORMAT_LABEL names the command in the output lines.

import GLib from "gi://GLib?version=2.0"
import System from "system"
import { formatConfig } from "../src/lib/configFormat"

const read = (path: string): string => {
    const [ok, bytes] = GLib.file_get_contents(path)
    if (!ok) throw new Error(`could not read ${path}`)
    return new TextDecoder().decode(bytes)
}

const templatePath = GLib.getenv("WAM_FORMAT_TEMPLATE")
const targetPath = GLib.getenv("WAM_FORMAT_TARGET")
const label = GLib.getenv("WAM_FORMAT_LABEL") ?? "config format"
if (!templatePath || !targetPath) {
    printerr("format-config: WAM_FORMAT_TEMPLATE and WAM_FORMAT_TARGET must be set")
    System.exit(2)
}

let original: string
let template: string
try {
    original = read(targetPath)
    template = read(templatePath)
} catch (e) {
    printerr(`format-config: ${e}`)
    System.exit(1)
}

const result = formatConfig(template, original)
if (!result.ok) {
    printerr(`${label}: ${result.error}`)
    System.exit(1)
}

if (result.output === original) {
    print(`${label}: already canonical — nothing to do`)
    System.exit(0)
}

// the .bak of the ORIGINAL goes down before anything replaces the
// target — the same rail `wam config sync` rides on
const backup = `${targetPath}.bak`
if (!GLib.file_set_contents(backup, original)) {
    printerr(`${label}: could not write the backup ${backup} — file left unchanged`)
    System.exit(1)
}
if (!GLib.file_set_contents(targetPath, result.output)) {
    printerr(`${label}: could not write ${targetPath} (backup is at ${backup})`)
    System.exit(1)
}

const { placed, folded, panels, preserved } = result.stats
const parts = [`${placed} value${placed === 1 ? "" : "s"} placed at their documented slot`]
if (folded > 0) parts.push(`${folded} folded in from flat spellings`)
if (panels > 0) parts.push(`${panels} [[panel]] block${panels === 1 ? "" : "s"}`)
if (preserved > 0) {
    parts.push(
        `${preserved} unread key${preserved === 1 ? "" : "s"} preserved in the block at the end`,
    )
}
print(`${label}: ${parts.join(", ")}`)
print(`${label}: the original is backed up at ${backup}`)
