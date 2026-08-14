import { test, eq } from "./framework"
import { isGenericTitle, seriesFromTabTitle } from "../src/lib/mediaMeta"

test("isGenericTitle: a bare episode counter is not a title", () => {
    eq(isGenericTitle("Episode 1"), true)
    eq(isGenericTitle("EP 5"), true)
    eq(isGenericTitle("Chapter 12"), true)
    eq(isGenericTitle(" Episode 3 "), true)
})

test("isGenericTitle: a real title is left alone", () => {
    eq(isGenericTitle("The Beginning of All Battles"), false)
    eq(isGenericTitle("Episode 1: The Day Everything Changed"), false)
    eq(isGenericTitle(""), false)
})

test("seriesFromTabTitle: the watch-page shape", () => {
    // "Watch <series> (<alt title>) | EP N"
    eq(seriesFromTabTitle("Watch Some Series (Another Name) | EP 1"), "Some Series")
    eq(seriesFromTabTitle("Watch Some Series | EP 12"), "Some Series")
})

test("seriesFromTabTitle: a trailing alt-name paren drops only with a head", () => {
    eq(seriesFromTabTitle("Watch Some Series (Another Name) | EP 2"), "Some Series")
    // a paren-only tab title must not reduce to nothing
    eq(seriesFromTabTitle("(Some Series)"), "(Some Series)")
})

test("seriesFromTabTitle: nothing to strip means nothing to show", () => {
    // no Watch prefix and no EP tail: the tab title is not the series
    eq(seriesFromTabTitle("Some Series | EP"), "Some Series | EP")
})
