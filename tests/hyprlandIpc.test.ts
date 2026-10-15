import GLib from "gi://GLib?version=2.0"
import { test, eq } from "./framework"
import { hyprlandIpcProblem, hyprlandSocketPaths, hyprlandIpcUp } from "../src/lib/hyprlandIpc"
import { getHyprland } from "../src/lib/hyprlandGuard"

// The harness stages a fake Hyprland runtime ($WAM_TEST_TMP/rt/hypr/
// <sig> with both sockets) and points HYPRLAND_INSTANCE_SIGNATURE and
// XDG_RUNTIME_DIR at it. Tests here bend that env per case and restore
// it: config.ts is an import-time singleton, already constructed, and
// the config tests spawn their own processes, but restoring keeps the
// mutation local anyway.
//
// getHyprland() is only ever exercised on the NULL path here: with the
// harness's fake sockets it would construct the real singleton against
// a socket file that is not a socket — the exact segfault the guard
// exists to prevent.

const HIS = "HYPRLAND_INSTANCE_SIGNATURE"
const harnessSig = GLib.getenv(HIS) // "wam-shell-tests" from run.sh
const RT = GLib.getenv("WAM_TEST_TMP")! + "/rt"

function withSig(sig: string | null, fn: () => void) {
    try {
        if (sig === null) GLib.unsetenv(HIS)
        else GLib.setenv(HIS, sig, true)
        fn()
    } finally {
        if (harnessSig === null) GLib.unsetenv(HIS)
        else GLib.setenv(HIS, harnessSig, true)
    }
}

test("hyprlandIpc: harness sockets resolve to up", () => {
    eq(hyprlandIpcProblem(), null)
    eq(hyprlandIpcUp(), true)
    const paths = hyprlandSocketPaths()
    eq(paths.length, 2)
    eq(paths[0]?.endsWith("/.socket.sock"), true)
    eq(paths[1]?.endsWith("/.socket2.sock"), true)
})

test("hyprlandIpc: no signature is a problem", () => {
    withSig(null, () => {
        eq(hyprlandSocketPaths(), [])
        eq(hyprlandIpcUp(), false)
        const problem = hyprlandIpcProblem()
        eq(problem?.includes("HYPRLAND_INSTANCE_SIGNATURE"), true)
    })
})

test("hyprlandIpc: stale signature (socket dir absent)", () => {
    withSig("guard-no-such-instance", () => {
        eq(hyprlandIpcUp(), false)
        const problem = hyprlandIpcProblem()
        eq(problem?.includes("socket missing"), true)
        eq(problem?.includes("guard-no-such-instance"), true)
    })
})

test("hyprlandIpc: one socket of two is still down", () => {
    const dir = `${RT}/hypr/guard-half-instance`
    GLib.mkdir_with_parents(dir, 0o700)
    GLib.file_set_contents(`${dir}/.socket.sock`, "")
    withSig("guard-half-instance", () => {
        eq(hyprlandIpcUp(), false)
        eq(hyprlandIpcProblem()?.includes(".socket2.sock"), true)
    })
    GLib.unlink(`${dir}/.socket.sock`)
    GLib.rmdir(dir)
})

test("hyprlandGuard: no sockets, no construction", () => {
    // the #225 contract: the guarded accessor refuses to touch
    // AstalHyprland while the socket pair is absent — this returns
    // instead of segfaulting inside the library
    withSig("guard-no-such-instance", () => {
        eq(getHyprland(), null)
    })
})
