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

// title -> recovered art url. Bounded so a long listening session
// cannot grow it without limit; tracks repeat far more often than the
// cap is reached.
//
// A hit is final, a miss is NOT: chrome commits a visit on its own
// schedule and the db is read with immutable=1, which deliberately
// ignores the journal — so the row for a page that just started
// playing is routinely unreadable on the first look. Memoizing that
// as "nothing here" left the track blurred for the rest of the shell
// session. Misses are counted instead, and only become permanent once
// the budget is spent (a page that is not youtube never resolves, and
// must not spawn sqlite3 on every notify for the rest of the session).
const MAX_MEMO = 200
const MAX_MISSES = 3
const memo = new Map<string, string>()
const misses = new Map<string, number>()

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
    if (hit) return Promise.resolve(hit)
    if ((misses.get(title) ?? 0) >= MAX_MISSES) return Promise.resolve("")

    dbs ??= historyDbs()
    // no chromium browser installed at all: permanent, and not worth a
    // miss slot
    if (dbs.length === 0) return Promise.resolve("")

    const q = historyQuery(title)

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

/** the history lookup for a track title, ranked best match first.
 *  Exported for the tests: the db half needs a browser, the sql is
 *  pure string work.
 *
 *  Three tiers, because chrome stores the TAB title and youtube does
 *  not leave the video title alone in it:
 *
 *  1. `title = exact` — the video title verbatim, the common case.
 *  2. `title LIKE 'x - %'` — a site that appends its own suffix, which
 *     on youtube is " - YouTube" (93% of the watch rows in a real db).
 *  3. `title LIKE '(%) x - %'` — the same, behind youtube's unread
 *     count: "(3) Video Title - YouTube". A quarter of the rows in a
 *     real history db carry one, and tiers 1 and 2 are both anchored at
 *     the start of the string, so every one of them used to miss —
 *     which cost the track its full-size art for the whole session.
 *     Anchored on the "(" so this can only ever pick up a badge, never
 *     an arbitrary substring hit.
 *
 *  An exact hit outranks a suffix one, which outranks a badged one, and
 *  only then does the newest visit win: ORDER BY on the recency alone
 *  lets a looser match beat the row whose title IS the track, purely by
 *  being opened more recently. (sqlite scores each comparison as 1/0.)
 *  Among rows that tie, the same video watched twice carries the same
 *  art either way.
 *
 *  A row youtube never got to name at all — the SPA writes "YouTube" as
 *  the title when the navigation beats the title update, 7% of a real
 *  db — has nothing to match on and is simply not recoverable. */
export function historyQuery(title: string): string {
    const exact = sqlLiteral(title)
    const suffix = sqlLiteral(`${escapeLike(title)} - %`)
    const badged = sqlLiteral(`(%) ${escapeLike(title)} - %`)
    const isSuffix = `title LIKE ${suffix}${LIKE_ESCAPE}`
    return (
        "SELECT url FROM urls WHERE url LIKE '%youtube.com/watch?v=%' AND " +
        `(title = ${exact} OR ${isSuffix} OR title LIKE ${badged}${LIKE_ESCAPE}) ` +
        `ORDER BY (title = ${exact}) DESC, (${isSuffix}) DESC, ` +
        "last_visit_time DESC LIMIT 1;"
    )
}

/** i.ytimg thumbnail url for a youtube watch url, "" for anything else.
 *  Exported for the tests: the db half needs a browser, this half is
 *  pure string work. */
export function artForWatchUrl(url: string): string {
    const id = url.match(/[?&]v=([\w-]{6,})/)
    return id ? `https://i.ytimg.com/vi/${id[1]}/maxresdefault.jpg` : ""
}

function remember(title: string, url: string): Promise<string> {
    if (!url) {
        if (misses.size >= MAX_MEMO) misses.clear()
        misses.set(title, (misses.get(title) ?? 0) + 1)
        return Promise.resolve("")
    }
    if (memo.size >= MAX_MEMO) memo.clear()
    memo.set(title, url)
    misses.delete(title)
    return Promise.resolve(url)
}
