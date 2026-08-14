import GdkPixbuf from "gi://GdkPixbuf?version=2.0"
import GLib from "gi://GLib?version=2.0"
import { test, eq } from "./framework"
import {
    artForWatchUrl,
    escapeLike,
    historyQuery,
    isBrowserThumb,
    recentWatchIdsQuery,
} from "../src/lib/browserArt"
import { isSmallCover } from "../src/lib/coverArt"
import { thumbDiff } from "../src/lib/thumbMatch"

const TMP = GLib.getenv("WAM_TEST_TMP")!

test("isBrowserThumb: chromium's temp art, with or without the scheme", () => {
    eq(isBrowserThumb("file:///tmp/.org.chromium.Chromium.l6lsxg"), true)
    eq(isBrowserThumb("/tmp/.org.chromium.Chromium.l6lsxg"), true)
    eq(isBrowserThumb("file:///tmp/.com.brave.Browser.aB3xQz"), true)
})

test("isBrowserThumb: real local art is not a browser thumbnail", () => {
    // a music library cover, and a remote url that never gets this far
    eq(isBrowserThumb("file:///home/me/Music/Album/cover.jpg"), false)
    eq(isBrowserThumb("/tmp/some-other-app-art.png"), false)
    eq(isBrowserThumb("https://i.scdn.co/image/abc"), false)
})

test("artForWatchUrl: a watch url names the full-size thumbnail", () => {
    eq(
        artForWatchUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=23417s"),
        "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
    )
    // the id is not always the first parameter
    eq(
        artForWatchUrl("https://www.youtube.com/watch?app=desktop&v=McpoBHoAmGU"),
        "https://i.ytimg.com/vi/McpoBHoAmGU/maxresdefault.jpg",
    )
})

test("artForWatchUrl: anything that is not a watch url yields nothing", () => {
    eq(artForWatchUrl(""), "")
    eq(artForWatchUrl("https://anime.nexus/watch/019f325e/a-novice-seeker"), "")
    eq(artForWatchUrl("https://www.youtube.com/results?search_query=v=abc"), "")
})

test("escapeLike: wildcards in a track title stop being wildcards", () => {
    // unescaped, "lo_fi beats - %" also matches "lo-fi beats - Mix",
    // and a decoy visited more recently would win the ORDER BY
    eq(escapeLike("lo_fi beats"), "lo\\_fi beats")
    eq(escapeLike("100% Real"), "100\\% Real")
})

test("escapeLike: the escape character escapes itself", () => {
    // otherwise a title carrying a backslash would consume the
    // character after it and match something else entirely
    eq(escapeLike("AC\\DC"), "AC\\\\DC")
})

test("escapeLike: a title with no metacharacters is untouched", () => {
    eq(escapeLike("Some Ordinary Title"), "Some Ordinary Title")
    eq(escapeLike(""), "")
})

test("historyQuery: the three tiers a youtube tab title comes in", () => {
    const q = historyQuery("Some Track")
    // the video title verbatim, and the " - YouTube" suffix
    eq(q.includes("title = 'Some Track'"), true)
    eq(q.includes("title LIKE 'Some Track - %'"), true)
    // behind youtube's unread count: "(3) Some Track - YouTube". Both
    // other tiers are anchored at the start, so this used to miss a
    // quarter of a real history db outright
    eq(q.includes("title LIKE '(%) Some Track - %'"), true)
})

test("historyQuery: an exact hit outranks a suffix, which outranks a badge", () => {
    // ordering by recency alone lets a looser match beat the row whose
    // title IS the track, purely by being opened more recently
    const order = historyQuery("T").slice(historyQuery("T").indexOf("ORDER BY"))
    eq(order.indexOf("title = 'T'") < order.indexOf("title LIKE 'T - %'"), true)
    eq(order.indexOf("title LIKE 'T - %'") < order.indexOf("last_visit_time"), true)
})

test("historyQuery: wildcards stay escaped in the badge tier too", () => {
    const q = historyQuery("100% Real")
    eq(q.includes("'100\\% Real - %'"), true)
    eq(q.includes("'(%) 100\\% Real - %'"), true)
    // the equality tier reads no wildcards, so it only needs quoting
    eq(q.includes("title = '100% Real'"), true)
})

test("historyQuery: a quote in the title cannot break out of the literal", () => {
    eq(historyQuery("Don't Stop").includes("title = 'Don''t Stop'"), true)
})

// a real header read, since that is the whole point of isSmallCover
function png(name: string, w: number, h: number): string {
    const path = `${TMP}/${name}`
    const buf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, w, h)!
    buf.fill(0x336699ff)
    buf.savev(path, "png", [], [])
    return `file://${path}`
}

test("isSmallCover: chromium's 150px art is small, a 640px cover is not", () => {
    eq(isSmallCover(png("cover-small.png", 150, 84)), true)
    eq(isSmallCover(png("cover-big.png", 640, 640)), false)
})

test("isSmallCover: a missing file or a remote url is never small", () => {
    // the backdrop must not blur while a download is still in flight
    eq(isSmallCover(`file://${TMP}/cover-does-not-exist.png`), false)
    eq(isSmallCover("https://i.ytimg.com/vi/abc/maxresdefault.jpg"), false)
    eq(isSmallCover(""), false)
})

test("recentWatchIdsQuery: recent watch visits, newest first", () => {
    const q = recentWatchIdsQuery()
    // candidates come from the url column alone — titles are exactly
    // what this tier cannot trust
    eq(q.includes("SELECT url, last_visit_time FROM urls"), true)
    eq(q.includes("url LIKE '%youtube.com/watch?v=%'"), true)
    eq(q.includes("last_visit_time >"), true)
    eq(q.includes("ORDER BY last_visit_time DESC"), true)
})

function solid(rgba: number, alpha = false): GdkPixbuf.Pixbuf {
    const buf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, alpha, 8, 64, 36)!
    buf.fill(rgba)
    return buf
}

test("thumbDiff: identical art differs by nothing, opposites by 255", () => {
    eq(thumbDiff(solid(0x336699ff), solid(0x336699ff)), 0)
    eq(thumbDiff(solid(0x000000ff), solid(0xffffffff)), 255)
})

test("thumbDiff: a near colour is a small diff, a far one is not", () => {
    const near = thumbDiff(solid(0x000000ff), solid(0x0a0a0aff))
    const far = thumbDiff(solid(0x336699ff), solid(0xcc6633ff))
    eq(near, 10)
    // (153 + 0 + 102) / 3 — an unrelated thumbnail lives here, the
    // acceptance band sits far below it
    eq(far, 85)
})

test("thumbDiff: an alpha channel on one side does not count as content", () => {
    // (semi-transparent art would premultiply under the scaler, but the
    // sources this compares — jpeg candidates, chromium's rgb png —
    // never carry one)
    eq(thumbDiff(solid(0x336699ff), solid(0x336699ff, true)), 0)
})
