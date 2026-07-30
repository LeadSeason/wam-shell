import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"

// Long-lived children must not outlive the shell: with the read end of
// their stdout pipe gone they only die on their next write, and a quiet
// listener (mullvad between state changes) may never write again.
// Kept in its own module (not utils.ts) so the utils importers don't
// need a display: the shutdown hook is registered in app.tsx, which is
// the only place allowed to import ags/gtk4/app.
const streamedChildren = new Set<Gio.Subprocess>()

export function forceExitStreamedChildren() {
    streamedChildren.forEach(p => p.force_exit())
}

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
