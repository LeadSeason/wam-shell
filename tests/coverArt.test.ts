import { test, eq } from "./framework"
import { artCandidates } from "../src/lib/coverArt"

// artCandidates only proposes urls — the download walks them and keeps
// whichever answers, so the contract asserted here is "the big one is
// tried first AND the player's own url is still on the list".

const YT = "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"

test("artCandidates: youtube asks for maxres, then sd, then the original", () => {
    eq(artCandidates(YT), [
        "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
        "https://i.ytimg.com/vi/dQw4w9WgXcQ/sddefault.jpg",
        YT,
    ])
})

test("artCandidates: a url that is already maxres is not offered twice", () => {
    const url = "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg"
    eq(artCandidates(url), [
        "https://i.ytimg.com/vi/dQw4w9WgXcQ/sddefault.jpg",
        "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        url,
    ])
})

test("artCandidates: youtube webp and query strings survive the rewrite", () => {
    const url = "https://i.ytimg.com/vi_webp/abc123/mqdefault.webp?sqp=xyz"
    eq(artCandidates(url)[0], "https://i.ytimg.com/vi_webp/abc123/maxresdefault.webp?sqp=xyz")
})

test("artCandidates: spotify swaps the size class for 640px", () => {
    const url = "https://i.scdn.co/image/ab67616d00001e02ff9ca10b55ce82ae553c8228"
    eq(artCandidates(url), [
        "https://i.scdn.co/image/ab67616d0000b273ff9ca10b55ce82ae553c8228",
        url,
    ])
})

test("artCandidates: a non-album scdn url is left alone", () => {
    // artist and playlist images use different prefixes and have no
    // 640px sibling at that path
    const url = "https://i.scdn.co/image/ab6761610000e5eb1234567890abcdef12345678"
    eq(artCandidates(url), [url])
})

test("artCandidates: apple, deezer, last.fm and the cover art archive", () => {
    eq(
        artCandidates("https://is1-ssl.mzstatic.com/image/thumb/Music/x/y/100x100bb.jpg")[0],
        "https://is1-ssl.mzstatic.com/image/thumb/Music/x/y/1000x1000bb.jpg",
    )
    const dz = "https://e-cdns-images.dzcdn.net/images/cover/abc"
    eq(artCandidates(`${dz}/264x264-000000-80-0-0.jpg`)[0], `${dz}/1000x1000-000000-80-0-0.jpg`)
    eq(
        artCandidates("https://lastfm.freetls.fastly.net/i/u/174s/abc123.png")[0],
        "https://lastfm.freetls.fastly.net/i/u/abc123.png",
    )
    eq(
        artCandidates("https://coverartarchive.org/release/1234/5678-250.jpg")[0],
        "https://coverartarchive.org/release/1234/5678-1200.jpg",
    )
})

test("artCandidates: an unknown host is its own only candidate", () => {
    const url = "https://example.com/art.png"
    eq(artCandidates(url), [url])
})

test("artCandidates: a local path is passed through untouched", () => {
    // chromium writes its (150px) art to /tmp and reports the path;
    // downloadCover never sees these, but the list must not mangle one
    const url = "file:///tmp/.org.chromium.Chromium.l6lsxg"
    eq(artCandidates(url), [url])
})
