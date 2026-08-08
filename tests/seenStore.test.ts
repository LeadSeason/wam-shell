import GLib from "gi://GLib?version=2.0"
import { readFile } from "ags/file"
import { test, eq, runAsync } from "./framework"
import { createSeenStore, SeenStore } from "../src/lib/seenStore"

const TMP = GLib.getenv("WAM_TEST_TMP")!
let n = 0
const freshPath = () => `${TMP}/seen-${n++}.json`

// remember() persists through writeFileAtomic, which is async: drive the
// returned promise so the file is really there before reading it back
const remember = (store: SeenStore, ids: string[]) => runAsync(store.remember(ids))

test("seenStore: a missing file means this is the first run ever", () => {
    // the distinction the whole store exists for: a first run absorbs
    // the inbox silently instead of bannering all of it
    const store = createSeenStore(freshPath(), "Test")
    eq(store.firstEverRun, true)
    eq(store.ids(), new Set())
})

test("seenStore: an existing file is loaded, and is not a first run", () => {
    const path = freshPath()
    GLib.file_set_contents(path, JSON.stringify({ seen: ["a", "b"] }))
    const store = createSeenStore(path, "Test")
    eq(store.firstEverRun, false)
    eq(store.has("a"), true)
    eq(store.has("b"), true)
    eq(store.has("c"), false)
})

test("seenStore: a corrupt file is still not a first run", () => {
    // the file EXISTING is the signal. Treating an unparseable one as a
    // first run would banner the whole inbox once per corrupt file
    const path = freshPath()
    GLib.file_set_contents(path, "{ this is not json")
    const store = createSeenStore(path, "Test")
    eq(store.firstEverRun, false)
    eq(store.ids(), new Set())
})

test("seenStore: a file with the wrong shape loads as empty", () => {
    const path = freshPath()
    GLib.file_set_contents(path, JSON.stringify({ seen: "not-a-list" }))
    const store = createSeenStore(path, "Test")
    eq(store.ids(), new Set())
})

test("seenStore: ids are numbers-tolerant and stringified", () => {
    const path = freshPath()
    GLib.file_set_contents(path, JSON.stringify({ seen: [1, 2] }))
    const store = createSeenStore(path, "Test")
    eq(store.has("1"), true)
})

test("seenStore: remember persists and survives a reload", () => {
    const path = freshPath()
    const store = createSeenStore(path, "Test")
    remember(store, ["x", "y"])

    eq(JSON.parse(readFile(path)).seen.sort(), ["x", "y"])
    const reloaded = createSeenStore(path, "Test")
    eq(reloaded.has("x"), true)
    eq(reloaded.firstEverRun, false)
})

test("seenStore: remembering nothing new writes no file", () => {
    // a quiet poll must not rewrite the store every interval for the
    // life of the session
    const path = freshPath()
    const store = createSeenStore(path, "Test")
    remember(store, [])
    eq(GLib.file_test(path, GLib.FileTest.EXISTS), false)

    remember(store, ["a"])
    const before = readFile(path)
    remember(store, ["a"])
    eq(readFile(path), before)
})

test("seenStore: the file keeps the newest cap ids", () => {
    const path = freshPath()
    const store = createSeenStore(path, "Test", 3)
    remember(store, ["1", "2", "3", "4", "5"])
    // insertion order, newest last
    eq(JSON.parse(readFile(path)).seen, ["3", "4", "5"])
    // the in-memory set is not capped: everything this session saw still
    // suppresses a banner, the cap only bounds what survives a restart
    eq(store.has("1"), true)
})

test("seenStore: ids() is a copy, not the live set", () => {
    const store = createSeenStore(freshPath(), "Test")
    remember(store, ["a"])
    const snapshot = store.ids()
    snapshot.add("b")
    eq(store.has("b"), false)
})

test("seenStore: firstEverRun is cleared by the caller after its baseline", () => {
    const store = createSeenStore(freshPath(), "Test")
    eq(store.firstEverRun, true)
    store.firstEverRun = false
    eq(store.firstEverRun, false)
})
