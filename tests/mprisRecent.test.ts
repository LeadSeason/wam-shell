import { test, eq } from "./framework"
import {
    createRecentStore,
    isExcludedPlayer,
    isScrubbedTitle,
    type RecentPlayerInfo,
} from "../src/lib/mprisRecent"

/** a fake player: keyed by object identity like the real ones, named
 *  for assertions. `identity` doubles as the display name */
function player(name: string, identity: string | null = name, entry: string | null = null) {
    return { name, identity, entry }
}

/** the identity order `ordered()` produced */
const names = (list: { name: string }[]) => list.map(p => p.name)

test("recent: eligible never-played players keep bus order", () => {
    // nothing has played: the list is exactly what the switchers show
    // today (the eligible list, bus order)
    const a = player("a")
    const b = player("b")
    const store = createRecentStore<typeof a>()
    eq(
        names(
            store.ordered(
                [a, b],
                () => true,
                () => true,
            ),
        ),
        ["a", "b"],
    )
})

test("recent: played players order most recently played first", () => {
    const a = player("a")
    const b = player("b")
    const c = player("c")
    const store = createRecentStore<typeof a>()
    store.bump(a, 100)
    store.bump(b, 200)
    eq(
        names(
            store.ordered(
                [a, b, c],
                () => true,
                () => true,
            ),
        ),
        ["b", "a", "c"],
    )
    // playing the older one again re-takes the front
    store.bump(a, 300)
    eq(
        names(
            store.ordered(
                [a, b, c],
                () => true,
                () => true,
            ),
        ),
        ["a", "b", "c"],
    )
})

test("recent: a player that played stays listed after failing eligibility", () => {
    // the feature: a browser tab paused long enough for chromium to
    // clear its metadata fails the eligibility check (keep), but it
    // played this session and the bus name is still alive — one play
    // away from where the user left it
    const tab = player("tab")
    const live = player("live")
    const store = createRecentStore<typeof tab>()
    store.bump(tab, 100)
    eq(
        names(
            store.ordered(
                [tab, live],
                () => true,
                p => p === live,
            ),
        ),
        ["tab", "live"],
    )
    // never-played players do NOT get this treatment: without a bump,
    // keep=false drops them, as eligibility always has
    eq(
        names(
            store.ordered(
                [tab, live],
                () => true,
                () => false,
            ),
        ),
        ["tab"],
    )
})

test("recent: a dead player drops out of the list", () => {
    const a = player("a")
    const b = player("b")
    const store = createRecentStore<typeof a>()
    store.bump(a, 300)
    store.bump(b, 100)
    eq(
        names(
            store.ordered(
                [a, b],
                () => true,
                () => true,
            ),
        ),
        ["a", "b"],
    )
    // a quits: gone from the list, b keeps its remembered slot
    eq(
        names(
            store.ordered(
                [b],
                () => true,
                () => true,
            ),
        ),
        ["b"],
    )
    // a returns as a new bus object: keyed by identity, the old entry
    // cannot answer for it — it lists as never-played (bus order after
    // the remembered one), not at its old timestamp
    const a2 = player("a")
    eq(
        names(
            store.ordered(
                [a2, b],
                () => true,
                () => true,
            ),
        ),
        ["b", "a"],
    )
})

test("recent: exclusion is applied at derive time", () => {
    // config exclusions do not delete memory: a player recorded before
    // it was excluded falls back to the classic keep-only listing, so
    // editing remember_excluded takes effect without a restart
    const a = player("a", "Chromium", "chromium.desktop")
    const b = player("b")
    const store = createRecentStore<typeof a>()
    store.bump(a, 100)
    store.bump(b, 200)
    eq(
        names(
            store.ordered(
                [a, b],
                p => !isExcludedPlayer(p, ["chromium"]),
                p => !isExcludedPlayer(p, ["chromium"]),
            ),
        ),
        ["b"],
    )
})

test("recent: forget removes a player from the switchers outright", () => {
    const a = player("a")
    const b = player("b")
    const store = createRecentStore<typeof a>()
    store.bump(a, 300)
    store.bump(b, 100)
    store.forget(a)
    eq(store.isHidden(a), true)
    eq(store.isHidden(b), false)
    // gone whether it would list as remembered or merely eligible —
    // removal is outright, not a fall back to the tail
    eq(
        names(
            store.ordered(
                [a, b],
                () => true,
                () => false,
            ),
        ),
        ["b"],
    )
    eq(
        names(
            store.ordered(
                [a, b],
                () => true,
                () => true,
            ),
        ),
        ["b"],
    )
    // playing again undoes the forget: back, remembered afresh, even
    // though its keep() state has not changed
    store.bump(a, 400)
    eq(store.isHidden(a), false)
    eq(
        names(
            store.ordered(
                [a, b],
                () => true,
                () => false,
            ),
        ),
        ["a", "b"],
    )
    eq(
        names(
            store.ordered(
                [a, b],
                () => true,
                () => true,
            ),
        ),
        ["a", "b"],
    )
})

test("scrubbed titles: the browsers' anonymized placeholders", () => {
    eq(isScrubbedTitle("A site is playing media"), true) // chromium
    eq(isScrubbedTitle("Firefox is playing media"), true)
    eq(isScrubbedTitle("Brave is playing media"), true)
    // the placeholder always names something before the phrase; the
    // bare phrase is not one
    eq(isScrubbedTitle("is playing media"), false)
    eq(isScrubbedTitle("A site is playing media, loudly"), false)
    eq(isScrubbedTitle("Some Artist - A Real Track Title"), false)
    eq(isScrubbedTitle(""), false)
    eq(isScrubbedTitle(null), false)
})

test("exclusion: case-insensitive substrings over identity and entry", () => {
    const p: RecentPlayerInfo = { identity: "Chromium", entry: "chromium.desktop" }
    eq(isExcludedPlayer(p, ["chromium"]), true)
    eq(isExcludedPlayer(p, ["CHROMIUM"]), true)
    eq(isExcludedPlayer(p, [" chrome "]), false) // trimmed, not matched
    eq(isExcludedPlayer(p, ["chromium.desktop"]), true)
    eq(isExcludedPlayer(p, ["firefox"]), false)
    eq(isExcludedPlayer({ identity: "mpv", entry: null }, ["mpv"]), true)
    eq(isExcludedPlayer({ identity: null, entry: null }, ["mpv"]), false)
    // an empty list — or one of blank entries — excludes nothing
    eq(isExcludedPlayer(p, []), false)
    eq(isExcludedPlayer(p, ["", "  "]), false)
})
