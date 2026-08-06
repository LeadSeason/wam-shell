import { dayBucket } from "../../lib/relTime"

// Structure for the center's feed: day dividers, and runs from one app
// folded into a single line.
//
// A flat reverse-chronological list is honest and unreadable. Ten builds
// from one CI bot is ten rows that say nearly the same thing, and the
// two rows underneath them — the ones you actually opened the center
// for — are pushed off the bottom. Folding a run into "CI · 10" costs
// nothing (the run is still one click away) and gives everything else
// its space back.
//
// Kept free of GTK so it can be tested directly: the widget layer hands
// it rows and renders whatever comes back.

/** the least a feed row has to expose for this module to arrange it */
export interface FeedRow {
    key: string
    time: number
    appName: string
    iconName: string
}

export type FeedBlock<T extends FeedRow> =
    | { kind: "divider"; key: string; label: string }
    | { kind: "group"; key: string; appName: string; iconName: string; rows: T[] }

/**
 * A run shorter than this stays unfolded. Two rows from one app are not
 * a problem worth hiding behind a disclosure — the fold would cost a
 * click and save one line.
 */
const GROUP_MIN = 3

/**
 * Arrange feed rows into dividers and groups.
 *
 * @param rows newest first — the caller's sort is preserved exactly
 * @param nowSec unix seconds for "now", so day bucketing is pinnable
 * @param groupMin shortest run that folds into a group
 */
export function buildFeed<T extends FeedRow>(
    rows: T[],
    nowSec: number,
    groupMin: number = GROUP_MIN,
): FeedBlock<T>[] {
    if (rows.length === 0) return []

    // dividers only earn their line when there is more than one day in
    // the list; a center holding nothing but today's notifications does
    // not need to be told they are all from today
    const buckets = rows.map(r => dayBucket(r.time, nowSec))
    const multiDay = buckets.some(b => b !== buckets[0])

    const blocks: FeedBlock<T>[] = []
    let run: T[] = []
    let runBucket = ""

    // a run is only a run within one day: the same app either side of a
    // divider is two groups, or the fold would swallow the divider
    const flush = () => {
        if (run.length === 0) return
        blocks.push({
            // the first row's key makes the group's identity stable
            // across rebuilds without depending on its position
            key: `group:${run[0].key}`,
            appName: run[0].appName,
            iconName: run[0].iconName,
            rows: run,
            kind: "group",
        })
        run = []
    }

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        const bucket = buckets[i]
        if (bucket !== runBucket) {
            flush()
            if (multiDay) blocks.push({ kind: "divider", key: `day:${bucket}`, label: bucket })
            runBucket = bucket
        } else if (run.length > 0 && run[0].appName !== row.appName) {
            flush()
        }
        run.push(row)
    }
    flush()

    // runs too short to fold become one group per row, so the renderer
    // has a single shape to deal with rather than two
    return blocks.flatMap(b => {
        if (b.kind !== "group" || b.rows.length >= groupMin) return [b]
        return b.rows.map(r => ({
            kind: "group" as const,
            key: `group:${r.key}`,
            appName: r.appName,
            iconName: r.iconName,
            rows: [r],
        }))
    })
}
