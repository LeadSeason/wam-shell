// Player-recency memory for the switchers, kept free of Astal/GTK
// imports so it can be tested directly (lib/mpris.ts calls
// AstalMpris.get_default() at import time, which the test harness must
// never do).
//
// A player that has played during this session stays listed in the
// switchers even after its metadata goes blank: a browser tab paused
// long enough for chromium to clear it reports no title and STOPPED,
// fails eligibility (lib/mpris isEligible), and would drop out of the
// switcher while the player is still alive on the bus — one play away
// from where you left it. Dead players need no memory (a bus name that
// quit is not switchable to anything), so entries are only ever read
// against the live player list and the whole store dies with the
// session; nothing here is persisted.

/** the slice of AstalMpris.Player this module reads */
export interface RecentPlayerInfo {
    identity: string | null
    entry: string | null
}

/** browsers scrub private-session metadata instead of hiding it: the
 *  track title arrives as an anonymized "<X> is playing media"
 *  placeholder (chromium sends "A site is playing media", firefox
 *  "Firefox is playing media" — english locale strings). A remembered
 *  row for one would carry no information, and a private window must
 *  not outlive its own playback in the UI, so such titles are never
 *  recorded. Mirrors the check in lib/mpris isEligible, which this
 *  module cannot import (it would drag AstalMpris back in). */
export function isScrubbedTitle(title: string | null | undefined): boolean {
    return !!title && title.endsWith(" is playing media")
}

/** does this player match the exclusion list? Case-insensitive
 *  substrings against identity AND desktop entry ("chromium" catches
 *  the several spellings browsers report). Blank entries are skipped,
 *  so an empty list — or one of empty strings — excludes nothing. */
export function isExcludedPlayer(p: RecentPlayerInfo, patterns: string[]): boolean {
    if (patterns.length === 0) return false
    const hay = `${p.identity ?? ""}\n${p.entry ?? ""}`.toLowerCase()
    for (const raw of patterns) {
        const needle = raw.trim().toLowerCase()
        if (needle !== "" && hay.includes(needle)) return true
    }
    return false
}

export interface RecentStore<P> {
    /** record that `p` just played: it becomes remembered and moves to
     *  the front of the ordering */
    bump(p: P, now?: number): void
    /**
     * the switcher order for the live player list: remembered players
     * first, most recently played first — currently ineligible ones
     * INCLUDED, which is the whole point — then players `keep` accepts
     * (eligibility) in bus order. A player is listed when it is
     * remembered AND `remembered(p)` holds (config exclusions, applied
     * here rather than at record time so editing the list takes effect
     * without a restart), or when it was never recorded and `keep(p)`
     * holds.
     *
     * Entries for players not in `live` are pruned: this runs on every
     * players-list change, so a bus name that quits cannot leave a
     * dead GObject behind in the map.
     */
    ordered(live: P[], remembered: (p: P) => boolean, keep: (p: P) => boolean): P[]
    /** forget everything (shutdown) */
    clear(): void
}

export function createRecentStore<P>(): RecentStore<P> {
    const playedAt = new Map<P, number>()

    return {
        bump(p, now = Date.now()) {
            playedAt.set(p, now)
        },

        ordered(live, remembered, keep) {
            const liveSet = new Set(live)
            for (const p of playedAt.keys()) {
                if (!liveSet.has(p)) playedAt.delete(p)
            }

            const known: { p: P; at: number }[] = []
            const rest: P[] = []
            for (const p of live) {
                const at = playedAt.get(p)
                if (at !== undefined && remembered(p)) known.push({ p, at })
                else if (keep(p)) rest.push(p)
            }
            // stable sort: players recorded within the same millisecond
            // keep bus order among themselves
            known.sort((a, b) => b.at - a.at)
            return [...known.map(e => e.p), ...rest]
        },

        clear() {
            playedAt.clear()
        },
    }
}
