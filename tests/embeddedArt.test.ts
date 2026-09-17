import { test, eq, runAsync } from "./framework"
import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import GdkPixbuf from "gi://GdkPixbuf?version=2.0"
import Config from "../src/config"
import { embeddedArtCachePath, upgradeSmallCover } from "../src/lib/embeddedArt"

// upgradeSmallCover's GStreamer parse is validated by hand (a generated
// tagged mp3 through the real pipeline); what the suite pins down is the
// decision layer around it: cache keying, scheme gating and the
// bigger-than-current width check on the cache-hit path

const dir = `${GLib.get_tmp_dir()}/wam-embedded-test-${GLib.random_int()}`
GLib.mkdir_with_parents(dir, 0o700)
// the seeded cache files below land in the (test-redirected) instance
// cache dir, which the suite harness does not create
GLib.mkdir_with_parents(Config.instanceCacheDir, 0o700)

function makePng(path: string, w: number, h: number) {
    const pix = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, w, h)
    if (!pix.savev(path, "png", [], [])) throw new Error(`could not write ${path}`)
}

function makeTrack(path: string): string {
    GLib.file_set_contents(path, new Uint8Array([0]))
    const info = Gio.File.new_for_path(path).query_info(
        "time::modified",
        Gio.FileQueryInfoFlags.NONE,
        null,
    )
    return `${info.get_attribute_uint64("time::modified")}`
}

test("embeddedArtCachePath: stable per url+mtime, sensitive to mtime, cover- prefix", () => {
    const a = embeddedArtCachePath("file:///a.mp3", 100)
    eq(embeddedArtCachePath("file:///a.mp3", 100), a)
    if (embeddedArtCachePath("file:///a.mp3", 101) === a)
        throw new Error("mtime did not change the key")
    if (embeddedArtCachePath("file:///b.mp3", 100) === a)
        throw new Error("url did not change the key")
    if (!a.startsWith(`${Config.instanceCacheDir}/cover-embed-`))
        throw new Error(`cache path left the instance dir: ${a}`)
})

test("upgradeSmallCover: a remote track url has no file to parse", () => {
    let result = "?"
    runAsync(
        upgradeSmallCover(`file://${dir}/current.png`, "https://example.com/a.mp3").then(r => {
            result = r
        }),
    )
    eq(result, "")
})

test("upgradeSmallCover: missing current art stays as-is", () => {
    const track = `${dir}/t1.mp3`
    makeTrack(track)
    let result = "?"
    runAsync(
        upgradeSmallCover(`file://${dir}/never-existed.png`, `file://${track}`).then(r => {
            result = r
        }),
    )
    eq(result, "")
})

test("upgradeSmallCover: a cached bigger embedded cover wins", () => {
    const track = `${dir}/t2.mp3`
    const mtime = makeTrack(track)
    const current = `${dir}/small.png`
    makePng(current, 100, 100)
    const cache = embeddedArtCachePath(`file://${track}`, Number(mtime))
    makePng(cache, 600, 600)
    let result = "?"
    runAsync(
        upgradeSmallCover(`file://${current}`, `file://${track}`).then(r => {
            result = r
        }),
    )
    eq(result, cache)
})

test("upgradeSmallCover: a cached smaller embedded cover keeps the published art", () => {
    const track = `${dir}/t3.mp3`
    const mtime = makeTrack(track)
    const current = `${dir}/medium.png`
    makePng(current, 320, 320)
    const cache = embeddedArtCachePath(`file://${track}`, Number(mtime))
    makePng(cache, 100, 100)
    let result = "?"
    runAsync(
        upgradeSmallCover(`file://${current}`, `file://${track}`).then(r => {
            result = r
        }),
    )
    eq(result, "")
})
