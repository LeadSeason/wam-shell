import GLib from "gi://GLib?version=2.0"
import Soup from "gi://Soup?version=3.0"
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
// Non-youtube sites go through the site tier: a server-rendered watch
// page names its full-size art in og:image, and the page is found in
// history by the track title slugged into the url (the media session
// reports the EPISODE title while the tab title carries the series, so
// the title tiers themselves rarely match there). A js-rendered shell
// with no meta tags still falls through to the blurred 150px thumb.

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

// title -> recovered art url, for the TITLE tiers only. Bounded so a
// long listening session cannot grow it without limit; tracks repeat
// far more often than the cap is reached.
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

// thumbnail tier results are memoized by PIXEL HASH, never by title.
// The title is exactly what this tier cannot trust (a title-rewriting
// extension is why it exists), and the thumb can even be the PREVIOUS
// track's: when a site's artwork is a video frame, it does not exist
// until the video decodes, so the title notify arrives while mpris
// still reports the old art. Match THAT thumb and the old video's art
// pins itself to the new title — a title-keyed memo would keep it
// wrong for the rest of the session. The same pixels always name the
// same video, so the hash is the honest key.
const thumbMemo = new Map<string, string>()

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
 *  "" when its page is not in any history db.
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
            if (art) return remember(title, art)
            // the site tier before the thumb one: for a non-youtube
            // track the thumb tier can only miss, at the cost of
            // fetching every candidate's mqdefault
            return siteArt(title).then(site => {
                // NOT remembered under the title: the slug/recency
                // match is heuristic, and a generic title ("Episode 2")
                // names a different page per series — a title-keyed
                // memo would show the first series' art for the second.
                // siteArt memoizes by page url instead, which keeps
                // repeat notifies of the same track from re-fetching.
                if (site) {
                    misses.delete(title)
                    return site
                }
                if (!thumbPath) return remember(title, "")
                return snapshotThumb(thumbPath).then(stable => {
                    // the snapshot's own content hash, when it is one of
                    // our copies (on a read failure it is the original
                    // path, and there is nothing safe to memoize under)
                    const hash = stable.match(/cover-bthumb-([0-9a-f]+)$/)?.[1]
                    const hit = hash && thumbMemo.get(hash)
                    if (hit) return Promise.resolve(hit)
                    return recentWatchIds(dbs!).then(ids =>
                        matchThumbId(stable, ids).then(id => {
                            // a miss still counts against the title's retry
                            // budget, but a hit is remembered by hash only
                            if (!id) return remember(title, "")
                            const art = `${THUMB_BASE}${id}/maxresdefault.jpg`
                            if (hash) {
                                if (thumbMemo.size >= MAX_MEMO) thumbMemo.clear()
                                thumbMemo.set(hash, art)
                            }
                            misses.delete(title)
                            return art
                        }),
                    )
                })
            })
        })
}

// ------------------------------------------------------------ site tier
//
// A non-youtube watch url names no thumbnail, but a server-rendered
// page names its full-size art in og:image. Finding the page is the
// hard half: the media session reports the EPISODE title while the
// history row carries the TAB title ("Watch <series> | EP 5" for the
// site this was written against), so the ordinary title tiers rarely
// match. What does carry the episode title is the url itself, as a
// slug — the tier matches on that, and on the title tiers for sites
// whose tab title does name the track.

/** a track title the way sites put it in a url: lowercase, runs of
 *  non-alphanumerics collapsed to single dashes. "" for a title with
 *  no latin alphanumerics at all (the slug tier then stays out — a
 *  contentless slug would match every url). Exported for the tests. */
export function slugifyTitle(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
}

// below this the slug is generic enough ("trailer", "op-1") that a
// substring hit in some recent url is more likely than the playing page
const MIN_SLUG_LEN = 8

/** the og:image (or twitter:image) of a fetched page, attribute order
 *  agnostic. Absolute urls only — a relative one says nothing about
 *  which host to ask. Exported for the tests. */
export function ogImageFromHtml(html: string): string {
    let twitter = ""
    for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
        const tag = m[0]
        const kind =
            tag.match(/(?:property|name)\s*=\s*"(og:image|twitter:image)"/i) ??
            tag.match(/(?:property|name)\s*=\s*'(og:image|twitter:image)'/i)
        if (!kind) continue
        const content =
            tag.match(/content\s*=\s*"([^"]*)"/i)?.[1] ?? tag.match(/content\s*=\s*'([^']*)'/i)?.[1]
        if (!content) continue
        const url = content.replace(/&amp;/g, "&")
        if (!/^https?:\/\//.test(url)) continue
        if (kind[1].toLowerCase() === "og:image") return url
        twitter ||= url
    }
    return twitter
}

/** the page candidates for a track, best match first: the youtube
 *  tiers minus the youtube filter, plus the slug tier. Exported for
 *  the tests: the db half needs a browser, the sql is pure string
 *  work. The row's title and last_visit_time ride along — the tab
 *  title is itself useful (mediaMeta derives a series name from it
 *  when the track title is generic) and the visit time lets rows from
 *  several dbs merge newest-first. Rows come back as JSON: titles DO
 *  contain "|" ("Watch X | EP 1"), sqlite's default separator, and the
 *  sqlite3 CLI caret-escapes control characters, so neither a pipe nor
 *  a char(31) separator survives the trip. */
export function sitePageQuery(title: string): string {
    const exact = sqlLiteral(title)
    const suffix = sqlLiteral(`${escapeLike(title)} - %`)
    const badged = sqlLiteral(`(%) ${escapeLike(title)} - %`)
    const isSuffix = `title LIKE ${suffix}${LIKE_ESCAPE}`
    const slug = slugifyTitle(title)
    const slugClause = slug.length >= MIN_SLUG_LEN ? ` OR url LIKE '%${slug}%'` : ""
    // chrome counts microseconds since 1601-01-01; a playing page's row
    // was written when its tab loaded, so the same window the thumb
    // tier uses applies (a long-lived tab older than it simply misses)
    const cutoff = Math.floor((Date.now() / 1000 - RECENT_WINDOW_SEC + 11644473600) * 1e6)
    return (
        "SELECT json_array(url, title, last_visit_time) FROM urls " +
        `WHERE url NOT LIKE '%youtube.com/%' AND last_visit_time > ${cutoff} AND ` +
        `(title = ${exact} OR ${isSuffix} OR title LIKE ${badged}${LIKE_ESCAPE}${slugClause}) ` +
        `ORDER BY (title = ${exact}) DESC, (${isSuffix}) DESC, last_visit_time DESC ` +
        `LIMIT ${SITE_CANDIDATES};`
    )
}

// how many candidate pages get fetched and scraped before the tier
// gives up (a hit short-circuits; three misses is a podcast homepage
// and two collisions)
const SITE_CANDIDATES = 3

/** recent history rows whose page could be playing `title`,
 *  newest-first, deduped by url — the candidate set behind both the
 *  site art tier and the generic-title enrichment in mediaMeta. Not
 *  config-gated: the gating decision belongs to the caller (which
 *  feature is asking). */
export function recentPagesForTitle(title: string): Promise<{ url: string; title: string }[]> {
    dbs ??= historyDbs()
    if (dbs.length === 0) return Promise.resolve([])
    const q = sitePageQuery(title)
    return Promise.all(
        dbs.map(db =>
            execAsync(["sqlite3", "-readonly", `file:${db}?immutable=1`, q])
                .then(out => out.trim())
                .catch(() => ""),
        ),
    ).then(outs => {
        const rows: [number, string, string][] = []
        for (const out of outs)
            for (const line of out.split("\n")) {
                try {
                    const [url, title, time] = JSON.parse(line)
                    if (url && title && time) rows.push([Number(time), url, title])
                } catch {
                    // a truncated or empty line is no candidate
                }
            }
        rows.sort((a, b) => b[0] - a[0])
        const pages: { url: string; title: string }[] = []
        for (const [, url, t] of rows)
            if (!pages.some(p => p.url === url)) pages.push({ url, title: t })
        return pages
    })
}

// send_and_read buffers the whole body: cap it so a heavy page cannot
// balloon memory, and reject non-html payloads outright
const MAX_PAGE_BYTES = 2 * 1024 * 1024
const pageSession = new Soup.Session({ timeout: 10 })

function fetchPage(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const msg = Soup.Message.new("GET", url)
        if (!msg) return reject(new Error(`invalid page url: ${url}`))
        pageSession.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (_s, res) => {
            try {
                const status = msg.get_status()
                if (status < 200 || status >= 300) throw new Error(`http ${status}: ${url}`)
                const type = msg.get_response_headers().get_one("Content-Type") ?? ""
                if (!type.includes("text/html"))
                    throw new Error(`not html (${type || "no content-type"}): ${url}`)
                const declared = Number(msg.get_response_headers().get_one("Content-Length")) || 0
                if (declared > MAX_PAGE_BYTES)
                    throw new Error(`page too large (${declared} bytes declared): ${url}`)
                const data = pageSession.send_and_read_finish(res)?.get_data()
                if (!data || data.length === 0) throw new Error(`empty response: ${url}`)
                if (data.length > MAX_PAGE_BYTES)
                    throw new Error(`page too large (${data.length} bytes): ${url}`)
                resolve(new TextDecoder().decode(data))
            } catch (e) {
                reject(e)
            }
        })
    })
}

// page url -> its og:image. Repeat notifies of the same track re-run
// the history query (site-tier results are deliberately NOT memoized
// by title — a generic title names a different page per series), but
// the page fetch is the expensive half and the page url is stable for
// the whole track
const pageMemo = new Map<string, string>()

// fetch each candidate in turn until one yields an og:image; a fetch
// or scrape failure just moves to the next candidate
function scrapeFirst(urls: string[]): Promise<string> {
    if (urls.length === 0) return Promise.resolve("")
    const hit = pageMemo.get(urls[0])
    if (hit) return Promise.resolve(hit)
    return fetchPage(urls[0])
        .then(html => {
            const art = ogImageFromHtml(html)
            if (!art) return scrapeFirst(urls.slice(1))
            if (pageMemo.size >= MAX_MEMO) pageMemo.clear()
            pageMemo.set(urls[0], art)
            return art
        })
        .catch(() => scrapeFirst(urls.slice(1)))
}

/** the og:image of the page playing `title`, or "" — the site tier of
 *  the recovery. */
function siteArt(title: string): Promise<string> {
    if (!Config.media.recoverSiteArt) return Promise.resolve("")
    return recentPagesForTitle(title).then(rows =>
        scrapeFirst(rows.map(r => r.url).slice(0, SITE_CANDIDATES)),
    )
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
