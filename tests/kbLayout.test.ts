import { test, eq } from "./framework"
import { flag } from "../src/lib/kbLayout"

test("flag: two-letter country code becomes a flag", () => {
    eq(flag("us"), "🇺🇸")
    eq(flag("de"), "🇩🇪")
})

test("flag: overrides for non-country codes", () => {
    eq(flag("ara"), "🇮🇶")
    eq(flag("latam"), "🌎")
    eq(flag("epo"), "🟩")
})

test("flag: variants and unknown codes yield no flag", () => {
    eq(flag("us_intl"), "")
    eq(flag(""), "")
})
