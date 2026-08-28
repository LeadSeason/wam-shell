// Player-list dedup, kept free of Astal/GTK imports so it can be tested
// directly (lib/mpris.ts calls AstalMpris.get_default() at import time,
// which the test harness must never do).

/** the slice of AstalMpris.Player the dedup reads */
export interface DedupablePlayer {
    /** full dbus name, "org.mpris.MediaPlayer2.<name>" */
    busName: string
    identity: string
    title: string
    get_meta(key: string): { deep_unpack<T>(): T } | null
}

/** the pid a chromium-style bus name embeds
 *  ("org.mpris.MediaPlayer2.brave.instance18798" -> 18798) */
const nativePid = (busName: string): number | null => {
    const m = /\.instance(\d+)$/.exec(busName)
    return m ? Number(m[1]) : null
}

/** collapse the several MPRIS names one media session can own.
 *
 *  One process can own several names when multiple bridges are installed
 *  (mpv-mpris uses mpv.instance<PID>, others mpv.instance-<id> and bare
 *  "mpv"): each name shows up as its own player, reporting the same
 *  identity and track.
 *
 *  KDE's Plasma Browser Integration is the harder case. It polyfills
 *  MPRIS for the browser's active tab IN ADDITION to the browser's own
 *  native bridge (chromium's org.mpris.MediaPlayer2.<browser>.instance<pid>
 *  bus name), and its title is undecorated where the native one carries
 *  the window's tab-count/suffix chrome — so identity+title does not see
 *  them as the same player. That leaves one tab owning two players, and a
 *  video starting makes the second look like "another player started" to
 *  the exclusive-pause hook in lib/mpris: the tab pauses itself within a
 *  second of every play.
 *
 *  The signal that ties them together is kde:pid, which the integration
 *  sets to the BROWSER's pid — the same pid the native bus name embeds.
 *  Match on that rather than on the integration's bus name: it registers
 *  BOTH a well-known "….plasma-browser-integration" name and a per-instance
 *  "….plasma-browser-integration-<its own pid>" one, and a bus-name test
 *  written for the first spelling silently lets the second one through
 *  (which is how the self-pause came back). A player is never its own
 *  duplicate — a native player is free to publish its own pid. */
export function dedupePlayers<P extends DedupablePlayer>(list: P[]): P[] {
    const native = new Map<number, P>()
    for (const p of list) {
        const pid = nativePid(p.busName)
        if (pid != null) native.set(pid, p)
    }

    const deduped = list.filter(p => {
        const pid = p.get_meta("kde:pid")?.deep_unpack<number>()
        if (pid == null) return true
        const owner = native.get(pid)
        return owner == null || owner === p
    })

    const seen = new Set<string>()
    return deduped.filter(p => {
        const key = `${p.identity}\n${p.title}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
}
