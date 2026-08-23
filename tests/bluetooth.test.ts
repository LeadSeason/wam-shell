import { test, eq } from "./framework"
import GLib from "gi://GLib?version=2.0"
import { batteryPercentValue, booleanHint } from "../src/lib/utils"
import { bluezErrorName, bluezErrorText } from "../src/lib/bluezErrors"

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

test("bluezErrorName: pulls the name out of a GDBus message", () => {
    eq(
        bluezErrorName(new Error("GDBus.Error:org.bluez.Error.AlreadyExists: Already Exists")),
        "AlreadyExists",
    )
    eq(
        bluezErrorName(new Error("GDBus.Error:org.bluez.Error.NotReady: Resource Not Ready")),
        "NotReady",
    )
})

test("bluezErrorName: anything that is not a bluez error is empty", () => {
    // a GDBus reply timeout, and a rejection that is not an Error at all
    eq(bluezErrorName(new Error("Timeout was reached")), "")
    eq(bluezErrorName("boom"), "")
    eq(bluezErrorName(null), "")
})

test("bluezErrorText: known bluez errors get their own wording", () => {
    eq(
        bluezErrorText(
            new Error("GDBus.Error:org.bluez.Error.AuthenticationFailed: Authentication Failed"),
            "Pairing failed",
        ),
        "Wrong PIN or passkey",
    )
})

test("bluezErrorText: an unmapped bluez error keeps the caller's summary", () => {
    // the summary names the operation, which beats bluez's "Failed"
    eq(
        bluezErrorText(new Error("GDBus.Error:org.bluez.Error.Failed: Failed"), "Pairing failed"),
        "Pairing failed",
    )
})

test("bluezErrorText: a reply timeout means bluez never answered", () => {
    // every call sets a timeout long enough that bluez would have
    // replied — reaching it is not the same as a slow operation
    eq(bluezErrorText(new Error("Timeout was reached"), "Pairing failed"), "Timed out")
})
