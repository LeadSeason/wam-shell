import { test, eq } from "./framework"
import { batteryPercentValue } from "../src/lib/utils"

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
