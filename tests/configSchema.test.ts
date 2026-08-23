import { test, eq } from "./framework"
import { createReader, numberList } from "../src/lib/configSchema"

// The readers behind src/config.ts. config.test.ts covers the resolved
// values end to end (one gjs process per scenario, which is slow); this
// covers the rules themselves, including the flat-fallback behaviour
// that is the whole reason the readers exist.

// collect the rejections instead of printing them
const withReport = () => {
    const messages: string[] = []
    return { messages, report: (m: string) => messages.push(m) }
}

test("configSchema: a section value wins over the top level", () => {
    const r = createReader({ spacing: 1, tray: { spacing: 9 } }, "tray")
    eq(r.num("spacing", 0), 9)
})

test("configSchema: a top-level value is the fallback", () => {
    const r = createReader({ spacing: 7 }, "tray")
    eq(r.num("spacing", 0), 7)
})

test("configSchema: sectionOnly ignores the top level entirely", () => {
    // the bug this prevents: a top-level on_panel meant for the tray
    // silently switching the sleep timer and harvest pills on too
    const data = { on_panel: true, sleep_timer: {} }
    const r = createReader(data, "sleep_timer")
    eq(r.bool("on_panel", false), true, "without the flag it leaks in")
    eq(r.bool("on_panel", false, { sectionOnly: true }), false)
})

test("configSchema: a section-wide sectionOnly applies to every key", () => {
    const data = { enabled: true, poll_minutes: 1, github: {} }
    const r = createReader(data, "github", { sectionOnly: true })
    eq(r.bool("enabled", false), false)
    eq(r.num("poll_minutes", 5), 5)
})

test("configSchema: flatKey renames the top-level spelling", () => {
    // tray.position falls back to tray_position, because a bare
    // "position" belongs to the workspaces
    const data = { position: "right", tray_position: "left", tray: {} }
    const r = createReader(data, "tray")
    eq(
        r.oneOf("position", ["left", "right"] as const, "left", { flatKey: "tray_position" }),
        "left",
    )
})

test("configSchema: a missing key returns the default silently", () => {
    const { messages, report } = withReport()
    const r = createReader({}, "tray", { report })
    eq(r.num("spacing", 4), 4)
    eq(r.bool("on_panel", true), true)
    eq(r.str("avatar", ""), "")
    eq(messages, [])
})

test("configSchema: a wrong type is reported and falls back", () => {
    const { messages, report } = withReport()
    const r = createReader({ tray: { spacing: "big", on_panel: 1 } }, "tray", { report })
    eq(r.num("spacing", 0), 0)
    eq(r.bool("on_panel", false), false)
    eq(messages.length, 2)
    eq(messages[0].includes('"tray.spacing"'), true, messages[0])
    eq(messages[1].includes('"tray.on_panel"'), true, messages[1])
})

test("configSchema: numeric bounds", () => {
    const { report } = withReport()
    const r = createReader({ s: { neg: -1, zero: 0, big: 500, frac: 0.5, over: 1.5 } }, "s", {
        report,
    })
    eq(r.num("neg", 3, { min: 0 }), 3, "below min falls back")
    eq(r.num("zero", 3, { min: 0 }), 0, "min 0 admits zero")
    eq(r.num("zero", 3, { positive: true }), 3, "positive rejects zero")
    eq(r.num("big", 3, { max: 100 }), 3, "above max falls back")
    eq(r.num("frac", 0.1, { min: 0, max: 1 }), 0.5)
    eq(r.num("over", 0.1, { min: 0, max: 1 }), 0.1)
})

test("configSchema: a non-finite number is not a number", () => {
    const { report } = withReport()
    const r = createReader({ s: { n: NaN, i: Infinity } }, "s", { report })
    eq(r.num("n", 5), 5)
    eq(r.num("i", 5), 5)
})

test("configSchema: floor clamps up instead of rejecting", () => {
    // a poll_minutes typo on a quota-metered API is corrected, not
    // refused — refusing would apply the much larger default and look
    // like the key was ignored
    const { messages, report } = withReport()
    const r = createReader({ youtube: { poll_minutes: 2 } }, "youtube", { report })
    eq(r.num("poll_minutes", 60, { positive: true, floor: 15 }), 15)
    eq(messages, [], "a clamped value is not an error")
})

test("configSchema: floor also applies to the default", () => {
    const r = createReader({}, "youtube")
    eq(r.num("poll_minutes", 5, { floor: 15 }), 15)
})

test("configSchema: oneOf accepts only the listed values", () => {
    const { messages, report } = withReport()
    const r = createReader({ osd: { position: "middle" } }, "osd", { report })
    eq(r.oneOf("position", ["bottom", "center", "top"] as const, "bottom"), "bottom")
    eq(messages[0].includes('"bottom" or "center" or "top"'), true, messages[0])
})

test("configSchema: strList drops bad entries but keeps the rest", () => {
    const r = createReader({ tray: { always_on_panel: ["a", 5, "", "b", null] } }, "tray")
    eq(r.strList("always_on_panel", []), ["a", "b"])
})

test("configSchema: a non-list rejects the whole value", () => {
    const { messages, report } = withReport()
    const r = createReader({ tray: { always_on_panel: "notalist" } }, "tray", { report })
    eq(r.strList("always_on_panel", []), [])
    eq(messages.length, 1)
})

test("configSchema: nonEmpty rejects an empty string", () => {
    const { report } = withReport()
    const r = createReader({ p: { host: "", name: "x" } }, "p", { report })
    eq(r.str("host", "127.0.0.1", { nonEmpty: true }), "127.0.0.1")
    eq(r.str("name", "fallback", { nonEmpty: true }), "x")
})

test("configSchema: a top-level reader has no flat fallback of its own", () => {
    const r = createReader({ instance_name: "wam-x" }, "")
    eq(r.str("instance_name", "wam-shell", { nonEmpty: true }), "wam-x")
    eq(r.str("absent", "default"), "default")
})

test("configSchema: numberList is all-or-nothing", () => {
    const { messages, report } = withReport()
    const fallback = [10, 15]
    eq(numberList("sleep_timer.presets", undefined, fallback, report), fallback)
    eq(numberList("sleep_timer.presets", [5, 10], fallback, report), [5, 10])
    // one bad entry rejects the lot: these are buttons, and silently
    // dropping one leaves a row missing an option with nothing to say why
    eq(numberList("sleep_timer.presets", [5, -1], fallback, report), fallback)
    eq(numberList("sleep_timer.presets", [], fallback, report), fallback)
    eq(numberList("sleep_timer.presets", "nope", fallback, report), fallback)
    eq(messages.length, 3)
})
