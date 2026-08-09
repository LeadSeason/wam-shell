import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { execAsync } from "./metrics"

// Clipboard history, through `cliphist`.
//
// Not hand-rolled, and it could not be: keeping a history means holding
// a wl-paste watcher open for the whole session and storing every
// selection, which is a daemon's job and is exactly what cliphist
// already does — including the part that is easy to get wrong, which is
// not corrupting binary payloads. The shell is a reader here.
//
// The daemon is `wl-paste --watch cliphist store`, started from the
// compositor config. Nothing here starts it: a shell that silently
// spawns a background recorder of everything you copy is not a
// behaviour to switch on for someone. When it is not running the list
// is empty, and the launcher says why.

export interface ClipEntry {
    /** cliphist's own id — the handle `decode` takes */
    id: string
    /** one-line preview, as cliphist renders it */
    preview: string
}

export function available(): boolean {
    return (
        GLib.find_program_in_path("cliphist") !== null &&
        GLib.find_program_in_path("wl-copy") !== null
    )
}

/**
 * The history, newest first.
 *
 * `cliphist list` emits "<id>\t<preview>" per line; the preview is
 * already collapsed to one line by cliphist (binary payloads come out
 * as "[[ binary data … ]]"), so nothing here has to guess at encodings.
 */
export async function history(): Promise<ClipEntry[]> {
    if (!available()) return []
    try {
        const out = await execAsync(["cliphist", "list"])
        return out
            .split("\n")
            .filter(line => line.trim() !== "")
            .map(line => {
                const tab = line.indexOf("\t")
                // no tab at all should not happen, but a malformed line
                // must not become an entry whose id is the whole line —
                // `decode` would then be handed something arbitrary
                if (tab < 0) return null
                return { id: line.slice(0, tab), preview: line.slice(tab + 1) }
            })
            .filter((e): e is ClipEntry => e !== null)
    } catch (e) {
        console.warn("clipboard: cliphist list failed:", e)
        return []
    }
}

/**
 * Put an entry back on the clipboard.
 *
 * `cliphist decode | wl-copy`, spliced as streams rather than passed
 * through a string: history entries can be images, and a round trip
 * through JS text would mangle every one of them. Splicing is also why
 * there is no shell in the middle — an id interpolated into `sh -c`
 * would be the one place this file could be made to run something else.
 */
export function copy(id: string): void {
    if (!available()) return
    try {
        const decode = Gio.Subprocess.new(
            ["cliphist", "decode", id],
            Gio.SubprocessFlags.STDOUT_PIPE,
        )
        const paste = Gio.Subprocess.new(["wl-copy"], Gio.SubprocessFlags.STDIN_PIPE)
        const source = decode.get_stdout_pipe()
        const sink = paste.get_stdin_pipe()
        if (!source || !sink) {
            console.warn("clipboard: could not open the decode pipe")
            return
        }
        sink.splice_async(
            source,
            Gio.OutputStreamSpliceFlags.CLOSE_SOURCE | Gio.OutputStreamSpliceFlags.CLOSE_TARGET,
            GLib.PRIORITY_DEFAULT,
            null,
            (stream, res) => {
                try {
                    stream!.splice_finish(res)
                } catch (e) {
                    console.warn("clipboard: copy failed:", e)
                }
            },
        )
    } catch (e) {
        console.warn("clipboard: copy failed:", e)
    }
}

/** Forget everything cliphist has stored. */
export async function wipe(): Promise<void> {
    if (!available()) return
    try {
        await execAsync(["cliphist", "wipe"])
    } catch (e) {
        console.warn("clipboard: wipe failed:", e)
    }
}
