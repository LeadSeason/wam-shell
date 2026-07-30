/**
 * File: utils.ts
 * Description: Mainly for helper functions
 */
import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import Pango from "gi://Pango?version=1.0"
import app from "ags/gtk4/app"

/**
 * Tests if a path points to a valid path
 * Will return true if the tested file is a symlink to a regular file.
 * @param path Path to a file
 */
export function isFile(path: string): boolean {
    // IS_REGULAR, not EXISTS: a directory at the expected path must not
    // pass (a "config.toml" directory, a cache dir named like a cover…)
    return GLib.file_test(path, GLib.FileTest.IS_REGULAR)
}

/**
 * Base text direction for alignment: true when the first strong
 * directional character is RTL (Hebrew, Arabic, …). Use to flip xalign.
 * NB: Pango.Direction has no STRONG_* members (that's fribidi);
 * find_base_dir returns LTR / RTL / NEUTRAL.
 */
export function isRtl(s: string): boolean {
    return Pango.find_base_dir(s, -1) === Pango.Direction.RTL
}

/**
 * Prepend an invisible right-to-left mark (U+200F) to every paragraph.
 * Gtk labels enable Pango auto-dir, which aligns each line by its OWN
 * paragraph direction — so a small LTR line ("Today 13:00") would hug
 * the left of an RTL card. The mark forces RTL base direction instead.
 */
export function rtlAlign(s: string): string {
    return "\u200F" + s.replaceAll("\n", "\n\u200F")
}

/**
 * Body text for useMarkup labels. The notification spec allows markup,
 * but plenty of apps send raw text with & or < in it — that fails Pango
 * parsing and renders an empty label. Keep valid markup, escape the
 * rest.
 */
export function safeMarkup(s: string): string {
    try {
        Pango.parse_markup(s, -1, 0)
        return s
    } catch {
        return GLib.markup_escape_text(s, -1)
    }
}

// Long-lived children must not outlive the shell: with the read end of
// their stdout pipe gone they only die on their next write, and a quiet
// listener (mullvad between state changes) may never write again
const streamedChildren = new Set<Gio.Subprocess>()
app.connect("shutdown", () => streamedChildren.forEach(p => p.force_exit()))

/**
 * Spawn a long-lived process, invoke onLine for each stdout line, and
 * onExit once when the stream closes (process exited or died).
 * Reads via the callback form of read_line_async: the GI promise form
 * is unreliable in gjs. Returns the subprocess, or null when the spawn
 * itself failed (e.g. the binary vanished despite a `which` probe).
 */
export function streamLines(
    argv: string[],
    onLine: (line: string) => void,
    onExit: () => void,
): Gio.Subprocess | null {
    let proc: Gio.Subprocess
    try {
        proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE)
    } catch (e) {
        console.warn(`streamLines: failed to spawn "${argv.join(" ")}":`, e)
        return null
    }
    streamedChildren.add(proc)
    const stream = Gio.DataInputStream.new(proc.get_stdout_pipe()!)

    const read = () => {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (_src, res) => {
            let line: string | null = null
            try {
                const [l] = stream.read_line_finish_utf8(res)
                line = l
            } catch (e) {
                console.warn(`streamLines: read failed for "${argv[0]}":`, e)
            }
            // null = EOF or read error; either way the process is gone
            if (line === null) {
                streamedChildren.delete(proc)
                onExit()
                return
            }
            try {
                onLine(line)
            } catch (e) {
                console.warn(`streamLines: handler failed for "${argv[0]}":`, e)
            }
            read()
        })
    }
    read()
    return proc
}
