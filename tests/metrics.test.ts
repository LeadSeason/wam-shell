// The metrics command and its wrappers, exercised via
// tests/metrics-probe.ts in a spawned process (the instrumentation is
// gated on WAM_SHELL_METRICS, read once at module load, so each scenario
// needs its own process).
import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { test, eq } from "./framework"

const PROBE = GLib.getenv("WAM_TEST_METRICS_PROBE")!

interface ProbeOutput {
    snap: any
    reset: any
    snap2: any
}

function runProbe(enabled: boolean): ProbeOutput {
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    })
    if (enabled) launcher.setenv("WAM_SHELL_METRICS", "1", true)
    else (launcher as any).unsetenv("WAM_SHELL_METRICS")

    const proc = launcher.spawnv([PROBE])
    const [, stdout, stderr] = proc.communicate_utf8(null, null)
    if (proc.get_exit_status() !== 0) throw new Error(`metrics-probe failed: ${stderr}`)

    // responses are "<instance>: <json>"; JSON starts at the first "{"
    const parse = (prefix: string) => {
        const line = stdout.split("\n").find(l => l.startsWith(prefix))
        if (!line) throw new Error(`no ${prefix} line in probe output:\n${stdout}`)
        return JSON.parse(line.slice(line.indexOf("{")))
    }
    return { snap: parse("SNAP "), reset: parse("RESET "), snap2: parse("SNAP2 ") }
}

test("metrics: wrappers feed the counters when enabled", () => {
    const { snap } = runProbe(true)

    eq(snap.enabled, true, "enabled")
    eq(snap.instance, "wam-shell", "instance")
    eq(snap.desktopSession, "hyprland", "desktopSession")

    eq(snap.subprocesses.true.count, 2, "exec + execAsync of true")
    eq(typeof snap.subprocesses.true.blockingMs, "number", "blockingMs recorded")

    eq(snap.timers.byLabel["probe:oneshot"], { created: 2, alive: 1 }, "oneshot timers")
    eq(snap.timers.byLabel["probe:seconds"], { created: 1, alive: 1 }, "seconds timer")
    eq(snap.timers.totalCreated, 3, "timers.totalCreated")
    eq(snap.timers.alive, 2, "timers.alive")

    eq(snap.signals.live, 1, "one handler left after disconnect")

    eq(snap.http["api.example.com"], { count: 2, bytes: 768 }, "http bucket")

    eq(snap.process.pid > 0, true, "pid")
    eq(snap.process.rssKb > 0, true, "rssKb")
    eq(snap.process.fds > 0, true, "fds")
    eq(typeof snap.process.voluntaryCtxtSwitches, "number", "voluntaryCtxtSwitches")
})

test("metrics: reset zeroes all counters", () => {
    const { reset, snap2 } = runProbe(true)

    eq(reset.ok, true, "reset response")
    eq(snap2.subprocesses, {}, "subprocesses cleared")
    eq(snap2.timers.totalCreated, 0, "timers cleared")
    eq(snap2.signals.live, 0, "signals cleared")
    eq(snap2.http, {}, "http cleared")
})

test("metrics: inert without WAM_SHELL_METRICS", () => {
    const { snap } = runProbe(false)

    eq(snap.enabled, false, "enabled")
    eq(snap.subprocesses, {}, "no subprocess counters")
    eq(snap.timers.totalCreated, 0, "no timer counters")
    eq(snap.signals.live, 0, "no signal counters")
    eq(snap.http, {}, "no http counters")
    // process facts are read at query time regardless
    eq(snap.process.pid > 0, true, "pid still present")
})
