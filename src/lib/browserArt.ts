import GLib from "gi://GLib?version=2.0"
import { execAsync } from "./metrics"
import { isFile } from "./utils"
import Config from "../config"

// Chromium downloads media-session artwork itself, downscales it to a
// 150px "desired size" for the system controls, writes the result to a
// temp file and reports THAT over mpris. The url it fetched is never
// exposed, so there is nothing for coverArt's size rewrites to work
// with — the shell gets 150x84 for a card that wants ~600 physical px.
//
// What the browser does keep is the page: the tab playing the media is
// in its own history db. Match the track title against it, and for
// youtube the video id in the url names the full-size thumbnail
// directly.
//
// Deliberately youtube-only. Any other site would need its page fetched
// and og:image scraped, which does not survive a js-rendered player —
// the one this was written against serves an empty html shell with no
// meta tags at all.

// the art chromium writes: a dotfile straight in the temp dir, named
// after the browser's application id
const THUMB_RE = /^\/tmp\/\.(?:org\.chromium\.|com\.google\.Chrome|com\.brave\.|org\.chromium)/

/** true when this mpris art url is a browser's own downscaled copy,
 *  i.e. a file we cannot get more pixels out of by any normal means. */
export function isBrowserThumb(url: string): boolean {
    const path = url.startsWith("file://") ? url.slice(7) : url
    return THUMB_RE.test(path)
}

// chromium keeps the db open, so read it without taking a lock and
// without copying 20-odd MB per track change. immutable=1 skips the
// journal too: a visit from the last few seconds may be missing, which
// costs us nothing — a page has to be open to be playing, so its row
// was written when the tab loaded.
function historyDbs(): string[] {
    const home = GLib.get_home_dir()
    const roots = [
        `${home}/.config/BraveSoftware/Brave-Browser`,
        `${home}/.config/google-chrome`,
        `${home}/.config/chromium`,
        `${home}/.config/microsoft-edge`,
        `${home}/.config/vivaldi`,
    ]
    const profiles = ["Default", "Profile 1", "Profile 2", "Profile 3"]
    const out: string[] = []
    for (const root of roots)
        for (const p of profiles) {
            const db = `${root}/${p}/History`
            if (isFile(db)) out.push(db)
        }
    return out
}

// resolved once: a browser installed mid-session is not worth a stat
// call on every track change
let dbs: string[] | null = null

// title -> recovered art url ("" = looked and found nothing). Bounded
// so a long listening session cannot grow it without limit; tracks
// repeat far more often than the cap is reached.
const MAX_MEMO = 200
const memo = new Map<string, string>()

function sqlLiteral(s: string): string {
    return `'${s.replace(/'/g, "''")}'`
}

/** a track title as a LIKE pattern fragment: % and _ are wildcards, so
 *  a title carrying either widens the match instead of narrowing it —
 *  "lo_fi beats" would also find "lo-fi beats - …". Escaped with a
 *  backslash, which sqlite only honours when ESCAPE says so (there is
 *  no default escape character), hence LIKE_ESCAPE below. */
export function escapeLike(s: string): string {
    return s.replace(/[\\%_]/g, m => `\\${m}`)
}

// sqlite reads no escapes inside string literals, so this really is one
// backslash by the time LIKE sees it
const LIKE_ESCAPE = String.raw` ESCAPE '\'`

/** the full-size art url for a track a chromium browser is playing, or
 *  "" when its page is not in any history db (or is not youtube).
 *
 *  The returned url still goes through downloadCover, so maxresdefault
 *  falling back to sd/hq is already handled there. */
export function recoverBrowserArt(title: string): Promise<string> {
    if (!title || !Config.media.recoverBrowserArt) return Promise.resolve("")
    const hit = memo.get(title)
    if (hit !== undefined) return Promise.resolve(hit)

    dbs ??= historyDbs()
    if (dbs.length === 0) return remember(title, "")

    // youtube stores the video title verbatim as the page title, so an
    // equality match is the common case; the LIKE catches the sites
    // that append their own suffix to it.
    //
    // An exact hit outranks a suffix one, and only then does the newest
    // visit win: ORDER BY on the recency alone lets a loose LIKE match
    // beat the row whose title IS the track, purely by being opened
    // more recently. (sqlite scores the comparison as 1/0.) Among rows
    // that tie, the same video watched twice carries the same art
    // either way.
    const exact = sqlLiteral(title)
    const suffix = sqlLiteral(`${escapeLike(title)} - %`)
    const q =
        "SELECT url FROM urls WHERE url LIKE '%youtube.com/watch?v=%' AND " +
        `(title = ${exact} OR title LIKE ${suffix}${LIKE_ESCAPE}) ` +
        `ORDER BY (title = ${exact}) DESC, last_visit_time DESC LIMIT 1;`

    return dbs
        .reduce(
            (chain, db) =>
                chain.then(found =>
                    found
                        ? found
                        : execAsync(["sqlite3", "-readonly", `file:${db}?immutable=1`, q])
                              .then(out => out.trim())
                              // a locked, corrupt or schema-changed db is
                              // not worth a warning on every track
                              .catch(() => ""),
                ),
            Promise.resolve(""),
        )
        .then(url => remember(title, artForWatchUrl(url)))
}

/** i.ytimg thumbnail url for a youtube watch url, "" for anything else.
 *  Exported for the tests: the db half needs a browser, this half is
 *  pure string work. */
export function artForWatchUrl(url: string): string {
    const id = url.match(/[?&]v=([\w-]{6,})/)
    return id ? `https://i.ytimg.com/vi/${id[1]}/maxresdefault.jpg` : ""
}

function remember(title: string, url: string): Promise<string> {
    if (memo.size >= MAX_MEMO) memo.clear()
    memo.set(title, url)
    return Promise.resolve(url)
}
