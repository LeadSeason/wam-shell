import { test, eq } from "./framework"
import { UnownedNameGuard } from "../src/lib/daemonWatch"

// #357: the half-dead start (the shell alive and drawing, owning no
// bus name) can only be cured from OUTSIDE the process — astal offers
// no re-claim, so the guard's job is to turn persistent unowned
// readings into an exit verdict and let the service restart the shell.
// The truth table is pinned here so nobody tunes it by accident.

test("guard: a single unowned reading only warns", () => {
    const g = new UnownedNameGuard(true, true)
    eq(g.tick("pending"), "watch")
    eq(g.tick("unowned"), "watch", "the settle tick can catch the claim mid-landing")
})

test("guard: two consecutive unowned readings exit", () => {
    const g = new UnownedNameGuard(true, true)
    g.tick("unowned")
    eq(g.tick("unowned"), "exit", "still unowned a full interval later — quit for the restart")
    eq(g.tick("unowned"), "exit", "and keeps exiting while the name stays unowned")
})

test("guard: any owned reading resets the count", () => {
    const g = new UnownedNameGuard(true, true)
    g.tick("unowned")
    eq(g.tick("ours"), "watch")
    eq(g.tick("unowned"), "watch", "one fresh unowned is not two")
    g.tick("foreign")
    eq(g.tick("unowned"), "watch", "foreign resets too — a restart cannot claim a held name")
})

test("guard: auto/system modes never exit", () => {
    const g = new UnownedNameGuard(false, true)
    g.tick("unowned")
    eq(g.tick("unowned"), "watch", "there the name may belong to another daemon by design")
})

test("guard: exit_if_unowned = false restores the warn-only watch", () => {
    const off = new UnownedNameGuard(true, false)
    off.tick("unowned")
    eq(off.tick("unowned"), "watch", "the #354 behavior, selectable again")
})
