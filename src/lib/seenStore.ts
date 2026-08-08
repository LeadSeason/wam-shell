import GLib from "gi://GLib?version=2.0"
import { isFile } from "./utils"
import { writeFileAtomic } from "./atomicWrite"

// A bounded, persisted set of "already known" ids.
//
// Banners have to survive restarts. A per-process baseline swallows
// every item that arrived while the shell was down, and between a
// long poll interval and a shell that restarts on updates or logout
// that is nearly all of them — the provider fills the center and never
// once bangs the screen. So the memory goes on disk.
//
// GitHub and YouTube each grew their own copy of this, with different
// bugs available to each: one tracked whether the store had ever
// existed (to absorb the first run silently) and the other did not.
// One implementation, one set of semantics.
//
// Bounded because it is a banner-suppression memory, not an archive:
// the newest `cap` ids are the only ones that can still be re-offered
// by a poll, and an unbounded file is one more thing that only grows.

const DEFAULT_CAP = 200

export interface SeenStore {
    /** has this id already been seen (so: must not banner)? */
    has(id: string): boolean
    /**
     * remember these ids and persist, keeping the newest `cap`.
     *
     * Returns when the write has landed. Callers are fire-and-forget
     * (the store already logs its own failures) — the promise is for
     * tests, which otherwise have no way to know the file is there.
     */
    remember(ids: string[]): Promise<void>
    /** every id currently held — for unioning into a banner filter */
    ids(): Set<string>
    /**
     * true when there was no store on disk at load: this process is the
     * first run ever, and its first poll is a baseline that must be
     * absorbed silently rather than bannered item by item. Cleared by
     * the caller once that baseline has landed.
     */
    firstEverRun: boolean
}

/**
 * @param path the JSON file backing the store (`{"seen": [...]}`)
 * @param logTag prefix for the two warnings this can emit
 * @param cap how many ids to keep, newest last
 */
export function createSeenStore(path: string, logTag: string, cap = DEFAULT_CAP): SeenStore {
    const seen = new Set<string>()
    let firstEverRun = true

    if (isFile(path)) {
        // the file existing is the whole signal: even an unreadable or
        // malformed one means this is not a first run, and treating it
        // as one would banner the entire inbox exactly once per corrupt
        // file rather than never
        firstEverRun = false
        try {
            const data = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(path)[1]))
            if (Array.isArray(data?.seen)) for (const id of data.seen) seen.add(String(id))
        } catch (e) {
            console.warn(`${logTag}: failed reading seen store:`, e)
        }
    }

    return {
        has: id => seen.has(id),
        ids: () => new Set(seen),
        remember(ids) {
            let added = false
            for (const id of ids) {
                if (seen.has(id)) continue
                seen.add(id)
                added = true
            }
            // a poll that surfaced nothing new must not rewrite the file
            // every interval for the life of the session
            if (!added) return Promise.resolve()
            // no mkdir: writeFileAtomic creates the parent directory
            return writeFileAtomic(path, JSON.stringify({ seen: [...seen].slice(-cap) })).catch(e =>
                console.warn(`${logTag}: failed writing seen store:`, e),
            )
        },
        get firstEverRun() {
            return firstEverRun
        },
        set firstEverRun(v: boolean) {
            firstEverRun = v
        },
    }
}
