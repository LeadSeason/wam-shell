import { test, eq } from "./framework"
import { registerPopup, closeOtherPopups } from "../src/lib/exclusivePopups"

// The rule these encode is easy to get wrong in exactly one direction:
// exclusion only worked one way for a while, because the notification
// center closed the quick settings but had never registered itself, so
// nothing could close it. The registry is tiny; the invariants are not
// obvious.

test("exclusivePopups: opening one closes every other, and never itself", () => {
    const closed: string[] = []
    registerPopup("a", () => closed.push("a"))
    registerPopup("b", () => closed.push("b"))
    registerPopup("c", () => closed.push("c"))

    closeOtherPopups("b")
    eq(closed.sort(), ["a", "c"])
})

test("exclusivePopups: re-registering a name replaces its closer", () => {
    // a rebuilt window must not leave a stale closer behind, pointing at
    // a widget that no longer exists
    const calls: string[] = []
    registerPopup("rebuilt", () => calls.push("stale"))
    registerPopup("rebuilt", () => calls.push("current"))

    closeOtherPopups("someone-else")
    eq(calls.includes("stale"), false, "the stale closer must not run")
    eq(calls.includes("current"), true)
})

test("exclusivePopups: one closer throwing does not stop the others", () => {
    // this runs from inside another popup's open path: aborting here
    // would leave the panel that triggered it half-opened
    const closed: string[] = []
    registerPopup("throws", () => {
        throw new Error("boom")
    })
    registerPopup("after", () => closed.push("after"))

    closeOtherPopups("nobody")
    eq(closed.includes("after"), true)
})

test("exclusivePopups: closing against an unregistered name is a no-op", () => {
    // every popup calls this on open, whether or not any other exists
    let ran = false
    registerPopup("only", () => (ran = true))
    closeOtherPopups("only")
    eq(ran, false)
})
