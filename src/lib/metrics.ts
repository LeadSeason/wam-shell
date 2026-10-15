import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import Gdk from "gi://Gdk?version=4.0"
import Gtk from "gi://Gtk?version=4.0"
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
// exported wrappers then ARE the original functions (no wrapper call,
// no allocation, no branch on any per-tick path) — with one exception:
// the timer callbacks always run through guardTicks below, because
// keeping a poll loop alive across a bad tick is correctness, not
// measurement. Read once here.
const ENABLED = GLib.getenv("WAM_SHELL_METRICS") === "1"

// Known holes by design:
// - src/config.ts runs one async systemctl probe through ags/process
//   directly (importing this module from there would be a cycle), so it
//   is unmeasured. It does not occur inside a measurement window
//   (counters are reset after startup).
// - timers created indirectly via ags/time (createPoll, timeout,
//   interval) call GLib.timeout_add inside ags, not at our call sites.
// - gnim's own subscriptions (createBinding, subscribe) connect signals
//   inside gnim.

// --- subprocesses ---------------------------------------------------------

interface ProcBucket {
    count: number
    blockingMs: number
}
const procs = new Map<string, ProcBucket>()

// the spawned binary: first token (string form) or argv[0], basename'd
function binName(cmd: string | string[]): string {
    const first = Array.isArray(cmd) ? cmd[0] : cmd.trim().split(/\s+/)[0]
    return first.split("/").pop() || first
}

function recordProc(bin: string, ms: number) {
    let b = procs.get(bin)
    if (!b) procs.set(bin, (b = { count: 0, blockingMs: 0 }))
    b.count++
    b.blockingMs += ms
}

export const exec: typeof agsExec = ENABLED
    ? cmd => {
          const t0 = GLib.get_monotonic_time()
          try {
              return agsExec(cmd)
          } finally {
              recordProc(binName(cmd), (GLib.get_monotonic_time() - t0) / 1000)
          }
      }
    : agsExec

export const execAsync: typeof agsExecAsync = ENABLED
    ? cmd => {
          recordProc(binName(cmd), 0)
          return agsExecAsync(cmd)
      }
    : agsExecAsync

// --- timer sources --------------------------------------------------------

interface TimerBucket {
    created: number
    alive: number
    ticks: number // total callback invocations (enabled mode only)
}
const timers = new Map<string, TimerBucket>()
const timerLabels = new Map<number, string>() // source id -> label

function bucketFor(label: string): TimerBucket {
    let b = timers.get(label)
    if (!b) timers.set(label, (b = { created: 0, alive: 0, ticks: 0 }))
    return b
}

// per-tick increment looks the bucket up in the map: a closure over
// the object would keep writing into a bucket `metrics reset` already
// replaced, and the fresh bucket would read zero ticks forever
function ticked(label: string) {
    const b = timers.get(label)
    if (b) b.ticks++
}

function timerCreated(label: string, id: number) {
    const b = bucketFor(label)
    b.created++
    b.alive++
    timerLabels.set(id, label)
}

function timerGone(id: number) {
    const label = timerLabels.get(id)
    if (label === undefined) return
    timerLabels.delete(id)
    timers.get(label)!.alive--
}

// One bad tick used to kill a source for good: GJS removes a timer
// whose callback throws, so a single transient failure (a spawn that
// errored once, a shape change in external JSON) froze that poll loop
// for the rest of the session — the "module stopped updating until
// restart" class of bug. The tick guard logs the throw and keeps the
// source alive; a broken callback (five CONSECUTIVE failures) is
// retired loudly instead of logging forever.
//
// This is correctness, not instrumentation: it runs with metrics off
// too, which is why the disabled wrappers below are no longer the bare
// GLib functions (only the timer ones — exec/connect stay zero-cost).
const TICK_STRIKES = 5

function guardTicks(
    label: string,
    fn: () => boolean,
    onEnd: () => void,
    onTick?: () => void,
): () => boolean {
    let strikes = 0
    return () => {
        let again: boolean
        try {
            again = fn()
            strikes = 0
        } catch (e) {
            strikes++
            if (strikes >= TICK_STRIKES) {
                console.error(
                    `timer ${label}: failed ${TICK_STRIKES} ticks in a row, stopping it:`,
                    e,
                )
                onEnd()
                return false
            }
            console.error(`timer ${label}: tick failed (${strikes}/${TICK_STRIKES}):`, e)
            again = true // a transient failure is not a reason to die
        }
        onTick?.()
        if (!again) onEnd()
        return again
    }
}

export const timeoutAdd = ENABLED
    ? (label: string, priority: number, interval: number, fn: () => boolean): number => {
          let id = 0
          id = GLib.timeout_add(
              priority,
              interval,
              guardTicks(
                  label,
                  fn,
                  () => timerGone(id),
                  () => ticked(label),
              ),
          )
          timerCreated(label, id)
          return id
      }
    : (label: string, priority: number, interval: number, fn: () => boolean): number =>
          GLib.timeout_add(
              priority,
              interval,
              guardTicks(label, fn, () => {}),
          )

export const timeoutAddSeconds = ENABLED
    ? (label: string, priority: number, interval: number, fn: () => boolean): number => {
          let id = 0
          id = GLib.timeout_add_seconds(
              priority,
              interval,
              guardTicks(
                  label,
                  fn,
                  () => timerGone(id),
                  () => ticked(label),
              ),
          )
          timerCreated(label, id)
          return id
      }
    : (label: string, priority: number, interval: number, fn: () => boolean): number =>
          GLib.timeout_add_seconds(
              priority,
              interval,
              guardTicks(label, fn, () => {}),
          )

export const idleAdd = ENABLED
    ? (label: string, priority: number, fn: () => boolean): number => {
          let id = 0
          id = GLib.idle_add(
              priority,
              guardTicks(
                  label,
                  fn,
                  () => timerGone(id),
                  () => ticked(label),
              ),
          )
          timerCreated(label, id)
          return id
      }
    : (label: string, priority: number, fn: () => boolean): number =>
          GLib.idle_add(
              priority,
              guardTicks(label, fn, () => {}),
          )

export const sourceRemove: typeof GLib.source_remove = ENABLED
    ? id => {
          timerGone(id)
          return GLib.source_remove(id)
      }
    : GLib.source_remove

// --- signal handlers (the leak detector) ----------------------------------

const signalLive = new Map<string, number>() // "Ctor:signal" -> live count
// handler ids are only unique per object, so track (object -> id -> bucket).
// Note: objects that are destroyed WITHOUT disconnect (exactly the leaks
// this detector exists to catch) stay strongly referenced here until the
// next metrics reset — the instrumentation keeps its suspects alive.
const signalBuckets = new Map<object, Map<number, string>>()

export const connect = ENABLED
    ? (
          obj: { connect(s: string, cb: (...a: any[]) => any): number },
          signal: string,
          callback: (...a: any[]) => any,
      ): number => {
          const ctor = (obj as any).constructor?.name ?? "?"
          const bucket = `${ctor}:${signal}`
          const id = obj.connect(signal, callback)
          signalLive.set(bucket, (signalLive.get(bucket) ?? 0) + 1)
          let ids = signalBuckets.get(obj)
          if (!ids) signalBuckets.set(obj, (ids = new Map()))
          ids.set(id, bucket)
          return id
      }
    : (
          obj: { connect(s: string, cb: (...a: any[]) => any): number },
          signal: string,
          callback: (...a: any[]) => any,
      ): number => obj.connect(signal, callback)

export const disconnect = ENABLED
    ? (obj: { disconnect(id: number): void }, id: number): void => {
          const ids = signalBuckets.get(obj)
          const bucket = ids?.get(id)
          if (bucket !== undefined) {
              ids!.delete(id)
              if (ids!.size === 0) signalBuckets.delete(obj)
              signalLive.set(bucket, signalLive.get(bucket)! - 1)
          }
          obj.disconnect(id)
      }
    : (obj: { disconnect(id: number): void }, id: number): void => obj.disconnect(id)

// --- HTTP -----------------------------------------------------------------

interface HttpBucket {
    count: number
    bytes: number
}
const http = new Map<string, HttpBucket>()

const noop = (_url: string, _bytes: number) => {}

// record one finished request: url for the host bucket, bytes = response
// body size received
export const trackHttp = ENABLED
    ? (url: string, bytes: number) => {
          const host = url.match(/^https?:\/\/([^/:]+)/)?.[1] ?? url
          let b = http.get(host)
          if (!b) http.set(host, (b = { count: 0, bytes: 0 }))
          b.count++
          b.bytes += bytes
      }
    : noop

// --- frame clock and cpu time ----------------------------------------------

// Rendered-frame counter on the probed surface — the idle frame-clock
// gate's raw data (snapshot().frames; reset zeroes it). The point: an
// idle shell's frame clock SLEEPS. A clock that ticks ~60/s while
// nothing is happening is a never-settling animation on an always-
// mapped surface, which is exactly what issue #338 was — the workspace
// playing pulse, ~7% kernel CPU (GL submit ioctls, zero user time) with
// the compositor recompositing both bars at full refresh, growing with
// uptime as each frame's heap walk collected refaults. Only the FIRST
// window handed here installs, so the counter always means "frames on
// one bar". The handler lives on the clock for the shell's lifetime —
// the surface it watches is that long-lived too.
let frameTicks = 0
let probeInstalled = false
const probedClocks = new Set<Gdk.FrameClock>()

function probeSurface(win: Gtk.Window): boolean {
    const clock = win.get_surface()?.get_frame_clock() ?? null
    if (!clock || probedClocks.has(clock)) return probedClocks.size > 0
    probedClocks.add(clock)
    connect(clock, "after-paint", () => {
        frameTicks++
    })
    return true
}

// A layer surface often has no Gdk.Surface until it is mapped, so the
// first call falls back to probing on map. Called from the bar window's
// ref callback — one call per bar, first wins.
export const installFrameProbe = ENABLED
    ? (win: Gtk.Window) => {
          if (probeInstalled) return
          if (probeSurface(win)) {
              probeInstalled = true
              return
          }
          const mapId = connect(win, "map", () => {
              disconnect(win, mapId)
              if (probeSurface(win)) probeInstalled = true
          })
      }
    : (_win: Gtk.Window) => {}

// --- snapshot -------------------------------------------------------------

function processFacts() {
    // procfs is not guaranteed (a container without /proc, a hardened
    // mount): the fd walk below has always tolerated that, but the
    // status read did not — and an exception here escapes through
    // CommandRegistry.execute, which turns the metrics reply into an
    // error string. The perf harness pipes that into jq and reports a
    // parse failure instead of the missing counters. Zeroes are the
    // honest answer; the fd fields already report the same way
    let status = ""
    try {
        status = readFile("/proc/self/status")
    } catch (err) {
        console.warn("metrics: /proc/self/status unreadable:", err)
    }
    const num = (re: RegExp) => Number(status.match(re)?.[1] ?? 0)

    // two counts, because most of them are not ours: the gpu buffers
    // (dmabuf, drm sync objects) held on this process rise and fall
    // with what the SESSION is drawing and playing, so the total swings
    // by a dozen between two runs of identical code — it cannot gate
    // anything. fdsOwned drops those and counts what a leak would show
    // up in: files, sockets, pipes, inotify, child pidfds
    let fds = 0
    let fdsOwned = 0
    try {
        const e = Gio.File.new_for_path("/proc/self/fd").enumerate_children(
            "standard::name,standard::symlink-target",
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null,
        )
        for (let info = e.next_file(null); info !== null; info = e.next_file(null)) {
            fds++
            const target = info.get_symlink_target() ?? ""
            if (!target.includes("dmabuf") && !target.includes("syncobj")) fdsOwned++
        }
        e.close(null)
        // the enumerator's own directory fd was counted in both
        fds--
        fdsOwned--
    } catch (err) {
        console.warn("metrics: fd count failed:", err)
    }

    return {
        pid: num(/^Pid:\t(\d+)/m),
        rssKb: num(/^VmRSS:\s+(\d+) kB/m),
        voluntaryCtxtSwitches: num(/^voluntary_ctxt_switches:\t(\d+)/m),
        fds,
        fdsOwned,
        // utime + stime from /proc/self/stat, in clock ticks (usually
        // 100/s). The idle cpu gate's raw data: the field after the
        // comm paren — comm can contain anything, so split AFTER the
        // last ")" and index from state (utime 11, stime 12).
        cpuTicks: (() => {
            try {
                const stat = readFile("/proc/self/stat")
                const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
                return Number(f[11]) + Number(f[12])
            } catch {
                return 0 // same deal as the status read above
            }
        })(),
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
        frames: ENABLED ? frameTicks : 0,
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
    frameTicks = 0
}

CommandRegistry.get_default().register({
    name: ["metrics"],
    description: "Performance counters as single-line JSON",
    subCommands: ["reset", "gc"],
    help: `metrics
  Returns a single line of JSON with counters (subprocesses, timers,
  signal handlers, http), process facts (pid, RSS, fds, context
  switches, cpuTicks) and frames (rendered frames on the probed bar
  since the last reset — the frame-clock sleep check). Timer buckets
  carry a per-label ticks count (callback invocations since the last
  reset; the runaway-poll detector). Counters are collected only when
  the shell was started with WAM_SHELL_METRICS=1.
  Note: the response is prefixed with "<instance>: "; JSON starts at
  the first "{".
metrics reset
  Zeroes all counters, for measuring a clean window.
metrics gc
  Forces a garbage collection, so leak counters reflect live objects
  only (the perf harness calls this after churn, before reading).`,
    main: argv => {
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
