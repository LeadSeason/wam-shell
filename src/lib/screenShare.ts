import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { createState } from "gnim"
import Config from "../config"
import { execAsync, timeoutAdd, sourceRemove } from "./metrics"
import { streamLines } from "./streamLines"
import { registerDispose } from "./lifecycle"

// Screen-share detection, event-driven through PipeWire itself. Any
// node with media.class Stream/Input/Video means a capture is active
// (portal screencast, camera grab). pw-dump -m streams graph changes
// through one long-lived process (streamLines); each burst re-reads
// the graph once (debounced).
//
// Note: the previous implementation counted AstalWp video streams, but
// AstalWp tracks zero streams on some setups (libastal/WirePlumber
// tracking gap) and the mask silently never engaged.
//
// Fails closed: pw-dump missing, spawn failing or an update throwing
// => sharing.
//
// Over-masking is accepted: a camera grab (a call with the camera on)
// counts too. TODO: discriminate portal screencasts from v4l2 grabs
// via the link target if that ever bothers anyone. Ambient grabbers
// with no audience (a Hue light sync) are ignored: the universal ones
// in ALWAYS_IGNORED below, personal ones in [screen_share] ignore_apps.

const [sharing, setSharing] = createState(false)
export { sharing }

// grabs that never have viewers, whoever runs them — matched like
// ignore_apps (case-insensitive, against application.name and node.name;
// huenicorn's pw-stream sets only node.name). Additions need the same
// "ambient consumer, never an audience" justification
const ALWAYS_IGNORED = ["huenicorn", "huenicornstream"]

let debounce = 0
let monitor: Gio.Subprocess | null = null
// one evaluation in flight at a time: a slow pw-dump (big graphs) must
// not complete after a newer one and land a stale sharing state
let evaluating = false
let evaluateAgain = false

export type VideoInput = { app: string; node: string; media: string }

// The video-input streams in a pw-dump, or null when the dump does not
// parse — exported for tests. Props can be sparse: a pw-stream client
// may set node.name without application.name (both are matched against
// screen_share.ignore_apps)
export function parseVideoInputs(dump: string): VideoInput[] | null {
    try {
        return (JSON.parse(dump) as { info?: { props?: Record<string, string> } }[])
            .map(o => o?.info?.props)
            .filter(
                (p): p is Record<string, string> =>
                    !!p && p["media.class"] === "Stream/Input/Video",
            )
            .map(p => ({
                app: p["application.name"] ?? "",
                node: p["node.name"] ?? "",
                media: p["media.name"] ?? p["node.description"] ?? "",
            }))
    } catch {
        return null
    }
}

// ignoreApps is already lowercased (src/config.ts) — exported for tests
export function ignoredVideoInput(v: VideoInput, ignoreApps: string[]): boolean {
    const app = v.app.toLowerCase()
    const node = v.node.toLowerCase()
    return [...ALWAYS_IGNORED, ...ignoreApps].some(i => i === app || i === node)
}

function describe(v: VideoInput): string {
    return `${v.app || v.node || "unknown"} (${v.media || "?"})`
}

async function evaluate() {
    if (evaluating) {
        evaluateAgain = true
        return
    }
    evaluating = true
    try {
        const out = await execAsync(["pw-dump"])
        const parsed = parseVideoInputs(out)
        const active = parsed?.filter(v => !ignoredVideoInput(v, Config.screenShare.ignoreApps))
        // an unparseable dump must not silently unmask: fall back to the
        // raw count, which knows nothing about the ignore list
        const rawCount = out.match(/"media\.class": "Stream\/Input\/Video"/g)?.length ?? 0
        const next = active ? active.length > 0 : rawCount > 0
        // diagnostics: on every mask/unmask flip, name what the dump
        // matched — a transient grab (camera probe, portal screencast)
        // is gone before anyone can inspect the graph, so the journal
        // is the only record
        if (next !== sharing.get())
            console.warn(
                next
                    ? `screenShare: masking — video input from: ${active ? active.map(describe).join(", ") : "unparseable dump"}`
                    : "screenShare: unmasking — no video input streams left",
            )
        setSharing(next)
    } catch (e) {
        console.warn("screenShare: pw-dump failed, failing closed (masking):", e)
        setSharing(true) // fail closed
    } finally {
        evaluating = false
        if (evaluateAgain) {
            evaluateAgain = false
            evaluate()
        }
    }
}

// portal negotiation and teardown churn the graph; debounce so the
// mask doesn't flicker
function scheduleEvaluate() {
    if (debounce) return
    debounce = timeoutAdd("screenShare:debounce", GLib.PRIORITY_DEFAULT, 300, () => {
        debounce = 0
        evaluate()
        return GLib.SOURCE_REMOVE
    })
}

let started = false
// set by dispose(): force_exit makes the monitor's pending read finish
// with EOF, which fires the onExit callback — that fail-closed path
// must not run for a kill we ordered ourselves
let disposed = false
let respawn = 0
// backoff for monitor respawns: a dead daemon makes pw-dump -m exit
// instantly, so a fixed retry would spin (and spam the log) for the
// whole outage; reset as soon as a respawned monitor produces output
let respawnDelay = 5_000
const RESPAWN_MAX = 120_000

// stderr silenced: pw-dump prints protocol noise during portal churn
// (resource races), which would otherwise flood the shell log
function spawnMonitor() {
    monitor = streamLines(
        ["pw-dump", "-m"],
        () => {
            respawnDelay = 5_000
            scheduleEvaluate()
        },
        () => {
            if (disposed) return
            // the monitor died: we can't know — fail closed and respawn
            // ourselves. Consumers call enable() once at setup, so a
            // dead monitor otherwise meant masked until a shell restart
            console.warn("screenShare: pw-dump -m monitor exited, masking until it respawns")
            monitor = null
            setSharing(true) // fail closed
            respawn = timeoutAdd("screenShare:respawn", GLib.PRIORITY_DEFAULT, respawnDelay, () => {
                respawn = 0
                if (!disposed) spawnMonitor()
                return GLib.SOURCE_REMOVE
            })
            respawnDelay = Math.min(respawnDelay * 2, RESPAWN_MAX)
        },
        true,
    )
    if (!monitor && !disposed) {
        // the spawn failed (binary gone — an install-level problem, not
        // a transient one): fail closed, no retry; streamLines warned
        setSharing(true)
    } else if (monitor) {
        // baseline right away: a (re)spawned monitor clears a stale
        // fail-closed mask instead of waiting for the next graph event
        evaluate()
    }
}

// started by the consumer (the Harvest panel pill): detection only runs
// when something actually masks on it
export function enable() {
    if (started) return
    started = true
    disposed = false
    respawnDelay = 5_000
    spawnMonitor()
}

// convention for lib modules with long-lived sources, even though the
// shell never calls it today: one place that tears everything down
export function dispose() {
    disposed = true
    if (debounce) {
        sourceRemove(debounce)
        debounce = 0
    }
    if (respawn) {
        sourceRemove(respawn)
        respawn = 0
    }
    monitor?.force_exit()
    monitor = null
    started = false
}

// tear-down entry point, run from app.tsx on shutdown (lib/lifecycle)
registerDispose("screenShare", dispose)
