import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import System from "system"
import { exec as agsExec, execAsync as agsExecAsync } from "ags/process"
import { readFile } from "ags/file"
import Config from "../config"
import CommandRegistry from "./commandRegistry"

// Performance counters, queryable on a running shell via
//   ags request -i <instance> metrics
// (single-line JSON; "metrics reset" zeroes the counters).
//
// Everything is inert unless WAM_SHELL_METRICS=1 is set at startup: the
// exported wrappers then ARE the original functions (no wrapper call, no
// allocation, no branch on any per-tick path). Read once here.
const ENABLED = GLib.getenv("WAM_SHELL_METRICS") === "1"

// Known holes by design:
// - src/config.ts runs two startup-only exec calls (pwd, systemctl)
//   before this module could load without an import cycle; they never
//   occur inside a measurement window (reset after startup).
// - timers created indirectly via ags/time (createPoll, timeout,
//   interval) call GLib.timeout_add inside ags, not at our call sites.
// - gnim's own subscriptions (createBinding, subscribe) connect signals
//   inside gnim.

// --- subprocesses ---------------------------------------------------------

interface ProcBucket { count: number, blockingMs: number }
const procs = new Map<string, ProcBucket>()

// the spawned binary: first token (string form) or argv[0], basename'd
function binName(cmd: string | string[]): string {
    const first = Array.isArray(cmd) ? cmd[0] : cmd.trim().split(/\s+/)[0]
    return first.split("/").pop() || first
}

function recordProc(bin: string, ms: number) {
    let b = procs.get(bin)
    if (!b) procs.set(bin, b = { count: 0, blockingMs: 0 })
    b.count++
    b.blockingMs += ms
}

export const exec: typeof agsExec = ENABLED
    ? (cmd) => {
        const t0 = GLib.get_monotonic_time()
        try {
            return agsExec(cmd)
        } finally {
            recordProc(binName(cmd), (GLib.get_monotonic_time() - t0) / 1000)
        }
    }
    : agsExec

export const execAsync: typeof agsExecAsync = ENABLED
    ? (cmd) => {
        recordProc(binName(cmd), 0)
        return agsExecAsync(cmd)
    }
    : agsExecAsync

// --- timer sources --------------------------------------------------------

interface TimerBucket { created: number, alive: number }
const timers = new Map<string, TimerBucket>()
const timerLabels = new Map<number, string>() // source id -> label

function timerCreated(label: string, id: number): number {
    let b = timers.get(label)
    if (!b) timers.set(label, b = { created: 0, alive: 0 })
    b.created++
    b.alive++
    timerLabels.set(id, label)
    return id
}

function timerGone(id: number) {
    const label = timerLabels.get(id)
    if (label === undefined) return
    timerLabels.delete(id)
    timers.get(label)!.alive--
}

export const timeoutAdd = ENABLED
    ? (label: string, priority: number, interval: number, fn: () => boolean): number => {
        // assigned before the callback can ever fire (main loop is not
        // re-entered from here)
        let id = 0
        id = GLib.timeout_add(priority, interval, () => {
            const again = fn()
            if (!again) timerGone(id)
            return again
        })
        return timerCreated(label, id)
    }
    : (_label: string, priority: number, interval: number, fn: () => boolean): number =>
        GLib.timeout_add(priority, interval, fn)

export const timeoutAddSeconds = ENABLED
    ? (label: string, priority: number, interval: number, fn: () => boolean): number => {
        let id = 0
        id = GLib.timeout_add_seconds(priority, interval, () => {
            const again = fn()
            if (!again) timerGone(id)
            return again
        })
        return timerCreated(label, id)
    }
    : (_label: string, priority: number, interval: number, fn: () => boolean): number =>
        GLib.timeout_add_seconds(priority, interval, fn)

export const sourceRemove: typeof GLib.source_remove = ENABLED
    ? (id) => {
        timerGone(id)
        return GLib.source_remove(id)
    }
    : GLib.source_remove

// --- signal handlers (the leak detector) ----------------------------------

const signalLive = new Map<string, number>() // "Ctor:signal" -> live count
// handler ids are only unique per object, so track (object -> id -> bucket)
const signalBuckets = new Map<object, Map<number, string>>()

export const connect = ENABLED
    ? (obj: { connect(s: string, cb: (...a: any[]) => any): number },
        signal: string, callback: (...a: any[]) => any): number => {
        const ctor = (obj as any).constructor?.name ?? "?"
        const bucket = `${ctor}:${signal}`
        const id = obj.connect(signal, callback)
        signalLive.set(bucket, (signalLive.get(bucket) ?? 0) + 1)
        let ids = signalBuckets.get(obj)
        if (!ids) signalBuckets.set(obj, ids = new Map())
        ids.set(id, bucket)
        return id
    }
    : (obj: { connect(s: string, cb: (...a: any[]) => any): number },
        signal: string, callback: (...a: any[]) => any): number =>
        obj.connect(signal, callback)

export const disconnect = ENABLED
    ? (obj: { disconnect(id: number): void }, id: number): void => {
        const bucket = signalBuckets.get(obj)?.get(id)
        if (bucket !== undefined) {
            signalBuckets.get(obj)!.delete(id)
            signalLive.set(bucket, signalLive.get(bucket)! - 1)
        }
        obj.disconnect(id)
    }
    : (obj: { disconnect(id: number): void }, id: number): void =>
        obj.disconnect(id)

// --- HTTP -----------------------------------------------------------------

interface HttpBucket { count: number, bytes: number }
const http = new Map<string, HttpBucket>()

const noop = (_url: string, _bytes: number) => { }

// record one finished request: url for the host bucket, bytes = response
// body size received
export const trackHttp = ENABLED
    ? (url: string, bytes: number) => {
        const host = url.match(/^https?:\/\/([^/:]+)/)?.[1] ?? url
        let b = http.get(host)
        if (!b) http.set(host, b = { count: 0, bytes: 0 })
        b.count++
        b.bytes += bytes
    }
    : noop

// --- snapshot -------------------------------------------------------------

function processFacts() {
    const status = readFile("/proc/self/status")
    const num = (re: RegExp) => Number(status.match(re)?.[1] ?? 0)

    let fds = 0
    try {
        const e = Gio.File.new_for_path("/proc/self/fd")
            .enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
        while (e.next_file(null)) fds++
        e.close(null)
    } catch (err) {
        console.warn("metrics: fd count failed:", err)
    }

    return {
        pid: num(/^Pid:\t(\d+)/m),
        rssKb: num(/^VmRSS:\s+(\d+) kB/m),
        voluntaryCtxtSwitches: num(/^voluntary_ctxt_switches:\t(\d+)/m),
        fds,
    }
}

export function snapshot() {
    let timersCreated = 0
    let timersAlive = 0
    const timerByLabel: Record<string, TimerBucket> = {}
    for (const [label, b] of timers) {
        timersCreated += b.created
        timersAlive += b.alive
        timerByLabel[label] = { ...b }
    }

    let signalsLiveTotal = 0
    const signalByName: Record<string, number> = {}
    for (const [bucket, n] of signalLive) {
        if (n === 0) continue
        signalsLiveTotal += n
        signalByName[bucket] = n
    }

    return {
        enabled: ENABLED,
        instance: Config.instanceName,
        desktopSession: Config.desktopSession,
        process: processFacts(),
        subprocesses: Object.fromEntries(procs),
        timers: {
            totalCreated: timersCreated,
            alive: timersAlive,
            byLabel: timerByLabel,
        },
        signals: { live: signalsLiveTotal, byName: signalByName },
        http: Object.fromEntries(http),
    }
}

function reset() {
    procs.clear()
    timers.clear()
    timerLabels.clear()
    signalLive.clear()
    signalBuckets.clear()
    http.clear()
}

CommandRegistry.get_default().register({
    name: ["metrics"],
    description: "Performance counters as single-line JSON",
    subCommands: ["reset", "gc"],
    help: `metrics
  Returns a single line of JSON with counters (subprocesses, timers,
  signal handlers, http) and process facts (pid, RSS, fds, context
  switches). Counters are collected only when the shell was started
  with WAM_SHELL_METRICS=1. Note: the response is prefixed with
  "<instance>: " by the request handler; JSON starts at the first "{".
metrics reset
  Zeroes all counters, for measuring a clean window.
metrics gc
  Forces a garbage collection, so leak counters reflect live objects
  only (the perf harness calls this after churn, before reading).`,
    main: (argv) => {
        if (argv[0] === "reset") {
            reset()
            return JSON.stringify({ ok: true })
        }
        // force a GC so leak counts aren't polluted by uncollected
        // garbage (used by the perf harness after churn)
        if (argv[0] === "gc") {
            System.gc()
            return JSON.stringify({ ok: true })
        }
        return JSON.stringify(snapshot())
    },
})
