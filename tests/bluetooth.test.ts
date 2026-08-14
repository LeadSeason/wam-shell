import { test, eq } from "./framework"
import GLib from "gi://GLib?version=2.0"
import { batteryPercentValue, booleanHint } from "../src/lib/utils"

test("bluetooth batteryPercentValue: fractions become percents", () => {
    eq(batteryPercentValue(0.9), 90)
    eq(batteryPercentValue(1), 100)
    eq(batteryPercentValue(0.005), 1)
    eq(batteryPercentValue(0), 0)
})

test("bluetooth batteryPercentValue: unavailable stays -1", () => {
    eq(batteryPercentValue(-1), -1)
})

test("bluetooth batteryPercentValue: percent-mode values pass through", () => {
    eq(batteryPercentValue(90), 90)
    eq(batteryPercentValue(55.4), 55)
})

test("booleanHint: spec boolean hints pass through", () => {
    eq(booleanHint(new GLib.Variant("b", true)), true)
    eq(booleanHint(new GLib.Variant("b", false)), false)
    eq(booleanHint(null), false)
})

test("booleanHint: an int32 hint is coerced, not dropped", () => {
    // senders exist that put an int32 where the spec wants a boolean —
    // astal's typed getter logs a GLib critical on every such read
    eq(booleanHint(new GLib.Variant("i", 1)), true)
    eq(booleanHint(new GLib.Variant("i", 0)), false)
})

test("booleanHint: any other type is absent, silently", () => {
    eq(booleanHint(new GLib.Variant("s", "true")), false)
})
