import GLib from "gi://GLib?version=2.0"
import { execAsync } from "./metrics"
import { isFile } from "./utils"
import { writeFileAtomic } from "./atomicWrite"
import { matchThumbId } from "./thumbMatch"
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
// When the title cannot match at all — a title-rewriting extension
// (DeArrow) makes the media session report a title that exists nowhere
// in history — the recovery falls back to pixels: the extension leaves
// the artwork alone, so the 150px thumb still IS one of the recently
// visited watch pages' thumbnails, and thumbMatch finds which.
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
 *  thumbPath is chromium's own 150px temp file: the fallback for titles
 *  that no history row carries (see the header comment). The returned
 *  url still goes through downloadCover, so maxresdefault falling back
 *  to sd/hq is already handled there. */
export function recoverBrowserArt(title: string, thumbPath = ""): Promise<string> {
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
        .then(url => {
            const art = artForWatchUrl(url)
            if (art || !thumbPath) return remember(title, art)
            return snapshotThumb(thumbPath).then(stable =>
                recentWatchIds(dbs!).then(ids =>
                    matchThumbId(stable, ids).then(id =>
                        remember(title, id ? `${THUMB_BASE}${id}/maxresdefault.jpg` : ""),
                    ),
                ),
            )
        })
}

// chromium deletes the temp thumb on its own schedule while mpris still
// reports the path — observed mid-track, not just on track change — and
// the thumbnail tier needs the pixels for the whole retry ramp. Keep a
// copy, taken on first sight (a shell that starts after the deletion
// simply has nothing to match with until the next track). Keyed by
// CONTENT, not path: the temp name may be reused for a later track, and
// a stale copy would match the wrong video. cover- prefixed so
// coverArt's weekly prune collects it.
function snapshotThumb(path: string): Promise<string> {
    try {
        const [ok, bytes] = GLib.file_get_contents(path)
        if (!ok) return Promise.resolve(path)
        const hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.MD5, new GLib.Bytes(bytes))
        const copy = `${Config.instanceCacheDir}/cover-bthumb-${hash}`
        if (isFile(copy)) return Promise.resolve(copy)
        return writeFileAtomic(copy, bytes).then(() => copy)
    } catch {
        // already gone: the tier gets the original path and misses
        return Promise.resolve(path)
    }
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

const WATCH_ID_RE = /[?&]v=([\w-]{6,})/
const THUMB_BASE = "https://i.ytimg.com/vi/"

/** i.ytimg thumbnail url for a youtube watch url, "" for anything else.
 *  Exported for the tests: the db half needs a browser, this half is
 *  pure string work. */
export function artForWatchUrl(url: string): string {
    const id = url.match(WATCH_ID_RE)
    return id ? `${THUMB_BASE}${id[1]}/maxresdefault.jpg` : ""
}

// the thumbnail tier's reach: a watch page visited longer ago than this
// is a tab that could not still be open and playing
const RECENT_WINDOW_SEC = 24 * 60 * 60
// wide enough that the playing page survives a browsing burst pushing
// it down the recency list: rows, not videos — youtube writes two rows
// per visit (&sttick / &pp variants), and dedup happens after the read
const RECENT_ROWS = 400

/** the recent-watch-visits lookup behind the thumbnail tier, newest
 *  first. Exported for the tests: the db half needs a browser, the sql
 *  is pure string work. last_visit_time rides along so rows from
 *  several dbs can still be merged newest-first. */
export function recentWatchIdsQuery(): string {
    // chrome counts microseconds since 1601-01-01
    const cutoff = Math.floor((Date.now() / 1000 - RECENT_WINDOW_SEC + 11644473600) * 1e6)
    return (
        "SELECT url, last_visit_time FROM urls " +
        `WHERE url LIKE '%youtube.com/watch?v=%' AND last_visit_time > ${cutoff} ` +
        `ORDER BY last_visit_time DESC LIMIT ${RECENT_ROWS};`
    )
}

/** distinct video ids of recently visited watch pages across every
 *  history db, most recent first — the candidate set the thumbnail
 *  tier matches against. The title tier can stop at the first db that
 *  answers; candidates have to be merged, or a second profile's rows
 *  would silently never be tried. */
function recentWatchIds(dbs: string[]): Promise<string[]> {
    return Promise.all(
        dbs.map(db =>
            execAsync(["sqlite3", "-readonly", `file:${db}?immutable=1`, recentWatchIdsQuery()])
                .then(out => out.trim())
                .catch(() => ""),
        ),
    ).then(outs => {
        const visits: [number, string][] = []
        for (const out of outs)
            for (const line of out.split("\n")) {
                const sep = line.lastIndexOf("|")
                const id = sep > 0 && line.slice(0, sep).match(WATCH_ID_RE)
                if (id) visits.push([Number(line.slice(sep + 1)), id[1]])
            }
        visits.sort((a, b) => b[0] - a[0])
        const ids: string[] = []
        for (const [, id] of visits) if (!ids.includes(id)) ids.push(id)
        return ids
    })
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
