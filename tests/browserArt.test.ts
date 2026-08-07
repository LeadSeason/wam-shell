import GdkPixbuf from "gi://GdkPixbuf?version=2.0"
import GLib from "gi://GLib?version=2.0"
import { test, eq } from "./framework"
import { artForWatchUrl, escapeLike, isBrowserThumb } from "../src/lib/browserArt"
import { isSmallCover } from "../src/lib/coverArt"

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
