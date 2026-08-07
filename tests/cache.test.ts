// The cache file is user-writable and survives updates, so every shape a
// broken one can take has to resolve to "no cache" rather than to an
// exception: parseCacheData runs inside Cache.get_default(), which
// SwayGaps calls from main(), where a throw takes the shell's window
// construction down with it.
import { test, eq } from "./framework"
import { parseCacheData } from "../src/lib/cache"

test("cache: a well-formed record round-trips", () => {
    const data = parseCacheData(JSON.stringify({ lastSave: 42, gaps: true, gapsSize: 12 }))
    eq(data.lastSave, 42, "lastSave")
    eq(data.gaps, true, "gaps")
    eq(data.gapsSize, 12, "gapsSize")
})

test("cache: a record without lastSave gets one", () => {
    eq(parseCacheData(JSON.stringify({ gaps: false })).lastSave, 0)
})

// JSON.parse("null") RETURNS null instead of throwing, so this one used
// to escape the try/catch and blow up on the lastSave read
test("cache: a bare null is no cache, not a crash", () => {
    let reported: unknown = null
    eq(parseCacheData("null", e => (reported = e)).lastSave, 0, "falls back")
    eq(reported !== null, true, "the malformed file is reported")
})

test("cache: scalars and arrays are no cache either", () => {
    eq(parseCacheData("5").lastSave, 0, "number")
    eq(parseCacheData('"hello"').lastSave, 0, "string")
    eq(parseCacheData("true").lastSave, 0, "boolean")
    eq(parseCacheData("[1,2,3]").lastSave, 0, "array")
})

test("cache: unparseable content is reported and falls back", () => {
    let reported: unknown = null
    eq(parseCacheData("{not json", e => (reported = e)).lastSave, 0, "falls back")
    eq(reported !== null, true, "the parse error is reported")
})


// Per-field validation, not just the container shape: the cast is
// compile-time only, and SwayGaps binds these into typed GObject
// properties where a null or a string throws out of the property system.
test("cache: a bad field is dropped, not passed through", () => {
    const reported: unknown[] = []
    const push = (e: unknown) => reported.push(e)

    eq(parseCacheData('{"gapsSize":null}', push).gapsSize, undefined, "null gapsSize")
    eq(parseCacheData('{"gapsSize":"10"}', push).gapsSize, undefined, "string gapsSize")
    eq(parseCacheData('{"gaps":"true"}', push).gaps, undefined, "string gaps")
    eq(parseCacheData('{"lastSave":"x"}', push).lastSave, 0, "string lastSave defaults")
    eq(reported.length, 4, "each bad field is reported")
})

test("cache: good fields survive alongside a bad one", () => {
    const data = parseCacheData('{"lastSave":7,"gaps":true,"gapsSize":null}')
    eq(data.lastSave, 7, "lastSave")
    eq(data.gaps, true, "gaps")
    eq(data.gapsSize, undefined, "the bad field alone is dropped")
})

test("cache: an empty file is reported so the log can explain a reset", () => {
    let reported: unknown = null
    eq(parseCacheData("", e => (reported = e)).lastSave, 0, "falls back")
    eq(reported !== null, true, "empty is broken, not silently absent")
})
