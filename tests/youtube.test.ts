import { test, eq } from "./framework"
import { playlistVideoData, bannerCandidates } from "../src/lib/youtube"

const playlistItem = (over: any = {}) => ({
    snippet: {
        title: "Cool Video Title",
        channelTitle: "Some Channel",
        publishedAt: "2026-07-31T10:00:00Z",
        resourceId: { videoId: "abc123XYZ_0" },
        thumbnails: { default: { url: "https://i.ytimg.com/vi/abc123XYZ_0/default.jpg" } },
        ...over,
    },
})

test("youtube playlistVideoData: maps a playlist item", () => {
    const d = playlistVideoData(playlistItem())!
    eq(d.id, "youtube:abc123XYZ_0")
    eq(d.provider, "youtube")
    eq(d.appName, "Some Channel")
    eq(d.summary, "Some Channel")
    eq(d.body, "Cool Video Title")
    eq(d.iconName, "youtube-symbolic")
    eq(d.url, "https://www.youtube.com/watch?v=abc123XYZ_0")
    eq(d.imageUrl, "https://i.ytimg.com/vi/abc123XYZ_0/default.jpg")
    eq(d.videoId, "abc123XYZ_0")
    eq(d.time, Date.parse("2026-07-31T10:00:00Z") / 1000)
})

test("youtube playlistVideoData: missing thumbnail yields null imageUrl", () => {
    const d = playlistVideoData(playlistItem({ thumbnails: undefined }))!
    eq(d.imageUrl, null)
})

test("youtube playlistVideoData: incomplete items are dropped", () => {
    eq(playlistVideoData({}), null)
    eq(playlistVideoData({ snippet: {} }), null)
    eq(playlistVideoData(playlistItem({ title: "" })), null)
    eq(playlistVideoData(playlistItem({ channelTitle: "" })), null)
    eq(playlistVideoData(playlistItem({ publishedAt: "nope" })), null)
    eq(playlistVideoData(playlistItem({ resourceId: {} })), null)
})

test("youtube playlistVideoData: videoIds unsafe for filenames are dropped", () => {
    eq(playlistVideoData(playlistItem({ resourceId: { videoId: "../etc" } })), null)
})

test("youtube bannerCandidates: new ids minus prev and seen, within 48h", () => {
    const now = 1_800_000_000
    const prev = [{ id: "youtube:1" }, { id: "youtube:2" }]
    const item = (id: string, ageSec: number) => ({ id, time: now - ageSec })
    const next = [
        item("youtube:2", 60), // already in prev
        item("youtube:3", 3600), // fresh: banners
        item("youtube:4", 60), // seen: no banner
        item("youtube:5", 7 * 86_400), // enters the list but is days old: no banner
    ]
    const seen = new Set(["youtube:4"])
    eq(bannerCandidates(prev, next, seen, now), ["youtube:3"])
    eq(bannerCandidates(prev, prev.map(p => ({ ...p, time: now })), new Set(), now), [])
})
