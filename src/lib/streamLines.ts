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
 * onExit once when the stream closes (process exited or died), with
 * whether the process exited successfully. Reads via the callback form
 * of read_line_async: the GI promise form is unreliable in gjs. Returns
 * the subprocess, or null when the spawn itself failed (e.g. the binary
 * vanished despite a `which` probe).
 *
 * stderr is inherited by default (the journal is where a child's
 * complaints belong). silenceStderr discards it; mergeStderr pipes it
 * into the same line stream as stdout — for children whose FAILURE
 * signal is a stderr line the UI must see (tailscale's "Access denied"
 * fast-fail) or whose interleaved output only makes sense together.
 * mergeStderr wins when both flags are set.
 */
export function streamLines(
    argv: string[],
    onLine: (line: string) => void,
    onExit: (ok: boolean) => void,
    silenceStderr = false,
    mergeStderr = false,
): Gio.Subprocess | null {
    let proc: Gio.Subprocess
    try {
        proc = Gio.Subprocess.new(
            argv,
            Gio.SubprocessFlags.STDOUT_PIPE |
                (mergeStderr
                    ? Gio.SubprocessFlags.STDERR_PIPE
                    : silenceStderr
                      ? Gio.SubprocessFlags.STDERR_SILENCE
                      : 0),
        )
    } catch (e) {
        console.warn(`streamLines: failed to spawn "${argv.join(" ")}":`, e)
        return null
    }
    streamedChildren.add(proc)

    // one pump per pipe; onExit fires when the LAST closes — a process
    // that wrote its final stdout and still holds stderr open (or vice
    // versa) has not exited yet
    let open = mergeStderr ? 2 : 1
    const done = () => {
        if (--open === 0) {
            streamedChildren.delete(proc)
            let ok = false
            try {
                // joins first: safe even if the process outlived its
                // pipes by a beat
                ok = proc.get_successful()
            } catch {
                // status unobtainable — treat as failure
            }
            onExit(ok)
        }
    }
    const pump = (pipe: Gio.InputStream | null) => {
        if (!pipe) {
            done()
            return
        }
        const stream = Gio.DataInputStream.new(pipe)
        const read = () => {
            stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (_src, res) => {
                let line: string | null = null
                try {
                    const [l] = stream.read_line_finish_utf8(res)
                    line = l
                } catch (e) {
                    console.warn(`streamLines: read failed for "${argv[0]}":`, e)
                }
                // null = EOF or read error; this pipe is drained either way
                if (line === null) {
                    done()
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
    }
    pump(proc.get_stdout_pipe())
    if (mergeStderr) pump(proc.get_stderr_pipe())
    return proc
}
