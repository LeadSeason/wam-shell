import AstalMpris from "gi://AstalMpris?version=0.1"
import { Accessor, createBinding, createState, onCleanup } from "gnim"
import Config from "../config"
import { recentPagesForTitle } from "./browserArt"

// A browser track whose media-session metadata has no artist: the
// series name only exists in the playing page's tab title, and the
// track title can even be a bare counter ("Episode 1", album repeats
// it). The history lookup behind browserArt already finds the playing
// page — the tab title comes back with it, so the widget can show the
// series instead of the app name (or the bare number).

// "Episode 1", "EP 5", "Chapter 12" — a bare counter, not a title
const GENERIC_RE = /^(episode|ep|chapter)\s*[-.:]?\s*\d+$/i

export function isGenericTitle(title: string): boolean {
    return GENERIC_RE.test(title.trim())
}

/** series name from a watch-page tab title: strip the site's "Watch "
 *  prefix and the trailing " | EP N" segment, then a trailing
 *  parenthesized alt name when something remains. "" when nothing is
 *  left — the caller keeps the original title then. */
export function seriesFromTabTitle(tabTitle: string): string {
    let t = tabTitle.replace(/^watch\s+/i, "")
    t = t.replace(/\s+[|–—-]\s+(ep|episode)\s*\d+\s*$/i, "")
    // a trailing parenthesized alt name ("Title (Alt Title)"), when
    // something remains in front of it
    const noParen = t.replace(/\s+\([^()]+\)\s*$/, "").trim()
    return noParen || t.trim()
}

export interface EnrichedMeta {
    /** series name when resolved, else the track title */
    title: Accessor<string>
    /** the original track title when enriched, else the artist */
    sub: Accessor<string>
}

/** display labels for a player, enriched from the playing page's tab
 *  title when the browser reports no artist. A bare counter title
 *  ("Episode 1") is REPLACED by the series name with the counter as
 *  subtitle; a real title ("Golden Raana Farming") keeps the title line
 *  and the series name takes the subtitle over the app-name fallback.
 *  Lookups are keyed by art url + title: the title alone is exactly
 *  what is not unique here (every series has an "Episode 1"), but a
 *  new track always brings a new chromium thumb. */
export function enrichedMeta(player: AstalMpris.Player): EnrichedMeta {
    const title = createBinding(player, "title")
    const artist = createBinding(player, "artist")
    const art = createBinding(player, "artUrl")
    const [outTitle, setOutTitle] = createState(title.get() ?? "")
    const [sub, setSub] = createState(artist.get() ?? "")
    // imperative states, not computeds: createComputed's dep cache
    // compares falsy values loosely, and a sub that starts out "" was
    // observed to never pick up the resolved series while the title
    // (truthy from the start) did
    let series = ""
    let lookedUp = ""

    const sync = () => {
        const t = title.get() ?? ""
        if (series && isGenericTitle(t)) {
            // a bare counter is not a title: the series takes the title
            // line, the counter becomes the subtitle
            setOutTitle(series)
            setSub(t)
        } else if (series) {
            setOutTitle(t)
            setSub(series)
        } else {
            setOutTitle(t)
            setSub(artist.get() ?? "")
        }
    }

    const maybeEnrich = () => {
        const t = title.get() ?? ""
        // an artist means the player reported real metadata; leave it be
        if (!Config.media.enrichTitles || !t || artist.get()) {
            lookedUp = ""
            if (series) {
                series = ""
            }
            sync()
            return
        }
        const key = `${art.get()}\n${t}`
        if (lookedUp !== key) {
            lookedUp = key
            recentPagesForTitle(t).then(rows => {
                const found = rows
                    .map(r => seriesFromTabTitle(r.title))
                    // a derived name that still carries the track title
                    // isolated nothing ("Video Title - YouTube" is not a
                    // series), so reject it
                    .find(s => s && !s.toLowerCase().includes(t.toLowerCase()))
                if (lookedUp === key) {
                    series = found ?? ""
                    sync()
                }
            })
        }
        sync()
    }

    const unsubs = [
        title.subscribe(maybeEnrich),
        artist.subscribe(maybeEnrich),
        art.subscribe(maybeEnrich),
    ]
    onCleanup(() => unsubs.forEach(u => u()))
    maybeEnrich()

    return { title: outTitle, sub }
}
