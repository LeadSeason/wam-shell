import GdkPixbuf from "gi://GdkPixbuf?version=2.0"
import { fetchImage } from "./coverArt"

// The thumbnail tier of browser art recovery, for when the title tiers
// in browserArt cannot match: a title-rewriting extension (DeArrow is
// the one this was written against) makes the media session report a
// title that exists nowhere in the browser's history, so every title
// tier misses — permanently, for every rewritten video. What the
// extension does NOT touch is the artwork: chromium's 150px thumb is a
// straight downscale of the video's real youtube thumbnail. The video
// id of every recently visited watch page is right there in the
// history url column, so fetch each candidate's mqdefault and keep the
// one whose pixels the browser thumb actually is.
//
// Calibrated on a real session: the correct video scores a mean abs
// diff of ~3 at 64x36, the nearest wrong one ~77 — the acceptance
// band below sits an order of magnitude from either side, so a match
// that does not clear it decisively is treated as no match (blurred
// art is the designed fallback, WRONG art is not).

const GRID_W = 64
const GRID_H = 36

// mqdefault is 320x180 16:9 (hqdefault is 4:3 letterboxed, which would
// tax the correct match with bar pixels that differ per video)
const MATCH_MAX_DIFF = 25
// the runner-up must be at least this many times worse, so two copies
// of the same thumbnail in the candidate set abstain instead of
// picking one at random
const MATCH_MIN_SEPARATION = 2
// beyond this the recent-visits window is guessing, not recovering.
// 32 sounds like a lot of fetches, but a heavy browsing session puts a
// playing tab 19 distinct videos down the recency list within an hour
// (observed); each candidate is a ~15kb jpeg fetched in parallel
const MAX_CANDIDATES = 32

function grid(p: GdkPixbuf.Pixbuf): GdkPixbuf.Pixbuf {
    return p.scale_simple(GRID_W, GRID_H, GdkPixbuf.InterpType.BILINEAR)!
}

/** mean absolute difference over the rgb channels of two pixbufs,
 *  both rescaled to a small fixed grid first: dimensions and
 *  letterboxing of the source art must not count as content. */
export function thumbDiff(a: GdkPixbuf.Pixbuf, b: GdkPixbuf.Pixbuf): number {
    const ga = grid(a)
    const gb = grid(b)
    const pa = ga.get_pixels()!
    const pb = gb.get_pixels()!
    const sa = ga.get_rowstride()
    const sb = gb.get_rowstride()
    // scale_simple preserves the source's alpha channel; the stride
    // must still step over it, but only rgb counts as content
    const ca = ga.get_n_channels()
    const cb = gb.get_n_channels()
    let sum = 0
    for (let y = 0; y < GRID_H; y++)
        for (let x = 0; x < GRID_W; x++)
            for (let c = 0; c < 3; c++)
                sum += Math.abs(pa[y * sa + x * ca + c] - pb[y * sb + x * cb + c])
    return sum / (GRID_W * GRID_H * 3)
}

function decode(bytes: Uint8Array): GdkPixbuf.Pixbuf {
    const loader = new GdkPixbuf.PixbufLoader()
    loader.write(bytes)
    loader.close()
    const pixbuf = loader.get_pixbuf()
    if (!pixbuf) throw new Error("candidate thumb did not decode")
    return pixbuf
}

/** the video id whose mqdefault the browser thumb actually is, or ""
 *  when no candidate matches confidently (or the thumb file is gone —
 *  chromium deletes it on track change, and the caller's staleness
 *  guard makes a late "" harmless). */
export function matchThumbId(thumbPath: string, ids: string[]): Promise<string> {
    let thumb: GdkPixbuf.Pixbuf
    try {
        thumb = GdkPixbuf.Pixbuf.new_from_file(thumbPath)!
    } catch {
        return Promise.resolve("")
    }
    return Promise.all(
        ids.slice(0, MAX_CANDIDATES).map(id =>
            fetchImage(`https://i.ytimg.com/vi/${id}/mqdefault.jpg`)
                .then(bytes => ({ id, diff: thumbDiff(thumb, decode(bytes)) }))
                // a 404 or a decode failure just narrows the field
                .catch(() => null),
        ),
    ).then(results => {
        const scored = results.filter(r => r !== null).sort((x, y) => x.diff - y.diff)
        const [best, second] = scored
        if (!best || best.diff > MATCH_MAX_DIFF) return ""
        if (second && best.diff * MATCH_MIN_SEPARATION > second.diff) return ""
        return best.id
    })
}
