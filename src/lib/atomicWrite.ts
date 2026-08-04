import Gio from "gi://Gio?version=2.0"
import GLib from "gi://GLib?version=2.0"

// Crash-safe file writes off the blocking GLib.file_set_contents path:
// the payload goes to a unique sibling tmp file (async Gio I/O) and is
// then renamed over the target, so a crash mid-write never leaves a
// truncated target behind. Writes to the same path are serialized on a
// per-path promise chain (start order = completion order: an older
// payload can't rename last and win). A failed write rejects only its
// own promise — the chain rides either branch, so one bad write can't
// wedge the next. Fire-and-forget callers must attach .catch or the
// rejection is unhandled (see cache.ts's logSaveError).
//
// opts.private: the tmp file is created 0600 (Gio.FileCreateFlags
// .PRIVATE) and rename preserves the tmp file's mode, so the target
// ends up owner-only even when it replaces an existing wider-moded
// file.

// gjs exposes no getpid; the pid comes from procfs so concurrent shell
// instances get distinct tmp names (random fallback still differs)
const pid = (() => {
    try {
        const [ok, stat] = GLib.file_get_contents("/proc/self/stat")
        if (ok) return new TextDecoder().decode(stat).split(" ")[0]
    } catch {
        /* fall through to the random name */
    }
    return `${GLib.random_int()}`
})()
let writeCounter = 0

// path -> tail of that path's write chain
const writeChains = new Map<string, Promise<unknown>>()

function replaceContentsAsync(
    file: Gio.File,
    bytes: Uint8Array,
    flags: Gio.FileCreateFlags,
): Promise<void> {
    return new Promise((resolve, reject) => {
        file.replace_contents_bytes_async(
            new GLib.Bytes(bytes),
            null,
            false,
            flags,
            null,
            (_f, res) => {
                try {
                    file.replace_contents_finish(res)
                    resolve()
                } catch (e) {
                    reject(e)
                }
            },
        )
    })
}

export function writeFileAtomic(
    path: string,
    data: string | Uint8Array,
    opts?: { private?: boolean },
): Promise<void> {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data
    // unique tmp name per write: overlapping writes to the same path
    // must not rename the tmp out from under a write still in flight
    const tmp = `${path}.tmp-${pid}-${writeCounter++}`
    const flags = opts?.private ? Gio.FileCreateFlags.PRIVATE : Gio.FileCreateFlags.NONE

    const run = async () => {
        try {
            // the parent dir may not exist yet (fresh cache dirs)
            const dir = GLib.path_get_dirname(path)
            if (!GLib.file_test(dir, GLib.FileTest.IS_DIR))
                Gio.File.new_for_path(dir).make_directory_with_parents(null)
            await replaceContentsAsync(Gio.File.new_for_path(tmp), bytes, flags)
            // rename preserves the tmp file's mode (0600 when private).
            // g_rename fails silently (target is a directory, ...) —
            // treat that as a failed write, don't report success
            if (GLib.rename(tmp, path) !== 0) throw new Error(`rename failed: ${tmp} -> ${path}`)
        } catch (e) {
            GLib.unlink(tmp) // don't leak the tmp of a failed write
            throw e
        }
    }

    // the chain outlives a failed write: the next write rides either branch
    const prev = writeChains.get(path) ?? Promise.resolve()
    const next = prev.then(run, run)
    writeChains.set(path, next)
    return next
}
