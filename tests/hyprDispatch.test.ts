import GLib from "gi://GLib?version=2.0"
import { test, eq } from "./framework"
import { createDispatcher } from "../src/lib/hyprDispatch"

// createDispatcher is async while the framework's test() is sync: drive
// each case on a nested main loop, same as atomicWrite.test
function run(...promises: Promise<unknown>[]) {
    const loop = new GLib.MainLoop(null, false)
    let failure: unknown = null
    Promise.all(promises).then(
        () => loop.quit(),
        e => {
            failure = e
            loop.quit()
        },
    )
    loop.run()
    if (failure) throw failure
}

const LUA = `hl.dsp.focus({workspace="2"})`
const LEGACY = ["workspace", "2"]

/** a fake hyprctl. `luaOk`/`legacyOk` decide which grammar this
 *  pretend-Hyprland understands; every argv is recorded */
function fakeHyprctl({ luaOk, legacyOk }: { luaOk: boolean; legacyOk: boolean }) {
    const calls: string[][] = []
    const warnings: string[] = []
    const exec = (argv: string[]) => {
        calls.push(argv)
        const isLua = argv[2]?.startsWith("hl.")
        const ok = isLua ? luaOk : legacyOk
        return ok ? Promise.resolve("ok") : Promise.reject(new Error("dispatch rejected"))
    }
    return { calls, warnings, exec, warn: (m: string) => warnings.push(m) }
}

test("hyprDispatch: 0.55+ takes the lua form and never spawns the legacy one", () => {
    const h = fakeHyprctl({ luaOk: true, legacyOk: false })
    const dispatch = createDispatcher(h.exec, h.warn)
    run(dispatch(LUA, LEGACY))
    eq(h.calls, [["hyprctl", "dispatch", LUA]])
    eq(dispatch.form, "lua")
    eq(h.warnings, [])
})

test("hyprDispatch: pre-0.55 falls back to the legacy form and says so", () => {
    const h = fakeHyprctl({ luaOk: false, legacyOk: true })
    const dispatch = createDispatcher(h.exec, h.warn)
    run(dispatch(LUA, LEGACY))
    eq(h.calls, [
        ["hyprctl", "dispatch", LUA],
        ["hyprctl", "dispatch", "workspace", "2"],
    ])
    eq(dispatch.form, "legacy")
    eq(h.warnings.length, 1)
})

// the whole point of remembering: the fallback costs one extra spawn
// once, not one on every workspace click
test("hyprDispatch: the working grammar is remembered", () => {
    const h = fakeHyprctl({ luaOk: false, legacyOk: true })
    const dispatch = createDispatcher(h.exec, h.warn)
    run(dispatch(LUA, LEGACY))
    eq(h.calls.length, 2, "first call probes")
    run(dispatch(LUA, LEGACY))
    eq(h.calls.length, 3, "second call does not probe again")
    eq(h.calls[2], ["hyprctl", "dispatch", "workspace", "2"])
})

test("hyprDispatch: a lua-only Hyprland is remembered too", () => {
    const h = fakeHyprctl({ luaOk: true, legacyOk: false })
    const dispatch = createDispatcher(h.exec, h.warn)
    run(dispatch(LUA, LEGACY))
    run(dispatch(LUA, LEGACY))
    eq(h.calls.length, 2)
    eq(h.calls[1], ["hyprctl", "dispatch", LUA])
})

// both failing means the dispatch itself was bad (a workspace that does
// not exist, say), NOT that the grammar was wrong: it must propagate so
// the caller logs it, and must not leave a guessed form cached
test("hyprDispatch: both grammars failing rejects and caches nothing", () => {
    const h = fakeHyprctl({ luaOk: false, legacyOk: false })
    const dispatch = createDispatcher(h.exec, h.warn)
    let rejected = false
    try {
        run(dispatch(LUA, LEGACY))
    } catch {
        rejected = true
    }
    eq(rejected, true, "the rejection reaches the caller")
    eq(dispatch.form, null, "no form cached, so the next call re-probes")
    eq(h.warnings, [])
})
