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

    eq(snap.timers.byLabel["probe:oneshot"], { created: 2, alive: 1, ticks: 0 }, "oneshot timers")
    eq(snap.timers.byLabel["probe:seconds"], { created: 1, alive: 1, ticks: 0 }, "seconds timer")
    eq(snap.timers.totalCreated, 3, "timers.totalCreated")
    eq(snap.timers.alive, 2, "timers.alive")

    eq(snap.signals.live, 1, "one handler left after disconnect")

    eq(snap.http["api.example.com"], { count: 2, bytes: 768 }, "http bucket")

    eq(snap.process.pid > 0, true, "pid")
    eq(snap.process.rssKb > 0, true, "rssKb")
    eq(snap.process.fds > 0, true, "fds")
    eq(typeof snap.process.voluntaryCtxtSwitches, "number", "voluntaryCtxtSwitches")
    eq(typeof snap.process.cpuTicks, "number", "cpuTicks")
    eq(snap.process.cpuTicks >= 0, true, "cpuTicks non-negative")
    // no frame probe is installed in this probe process: the counter
    // exists and reads zero
    eq(snap.frames, 0, "frames without a probe")
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
    eq(snap.frames, 0, "frames inert without metrics")
})

// --- the tick guard: correctness, so it holds with metrics OFF too ---

function runThrowProbe(budget: number, enabled: boolean): number {
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    })
    if (enabled) launcher.setenv("WAM_SHELL_METRICS", "1", true)
    launcher.setenv("WAM_PROBE_THROW_TIMER", String(budget), true)
    const proc = launcher.spawnv([PROBE])
    const [, stdout] = proc.communicate_utf8(null, null)
    if (proc.get_exit_status() !== 0) throw new Error("throw probe failed")
    const line = stdout.split("\n").find(l => l.startsWith("THROWS "))
    if (!line) throw new Error(`no THROWS line in probe output:\n${stdout}`)
    return JSON.parse(line.slice(line.indexOf("{"))).calls as number
}

for (const enabled of [false, true]) {
    const mode = enabled ? "metrics on" : "metrics off"

    test(`metrics: a throwing tick does not kill its timer (${mode})`, () => {
        // three failures, then success: the module-freeze class of bug —
        // the old wrapper let the first throw remove the source for good
        eq(runThrowProbe(3, enabled), 4, "callback survived to its successful call")
    })

    test(`metrics: five consecutive throws retire the timer (${mode})`, () => {
        // never succeeds: the guard must stop it at the strike budget —
        // not on the first throw, and not never (a runaway would show up
        // as the watchdog's ~66 calls)
        eq(runThrowProbe(0, enabled), 5, "stopped exactly at the strike budget")
    })
}
