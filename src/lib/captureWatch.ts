import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { createState } from "gnim"
import type { Accessor } from "gnim"
import Config from "../config"
import { execAsync, timeoutAdd, sourceRemove } from "./metrics"
import { streamLines } from "./streamLines"
import { registerDispose } from "./lifecycle"

// Capture detection, event-driven through PipeWire itself. One
// pw-dump -m watcher (one long-lived process through streamLines, each
// graph burst re-read once, debounced) feeding three privacy states:
//
//   sharing      any node with media.class Stream/Input/Video means a
//                video capture is active (portal screencast, camera
//                grab) — drives the [media]/[harvest] masks
//   cameraUsers  video-input streams LINKED to a device-backed
//                Video/Source: the camera itself is being grabbed
//   micUsers     running Stream/Input/Audio streams linked to an
//                Audio/Source: the microphone is being recorded
//
// Note: an earlier implementation counted AstalWp video streams, but
// AstalWp tracks zero streams on some setups (libastal/WirePlumber
// tracking gap) and the mask silently never engaged.
//
// Fails closed for the MASK: pw-dump missing, spawn failing or an
// update throwing => sharing. The camera/mic INDICATORS keep their
// last known state instead: an indicator must neither invent a
// recording nor drop one it can no longer see, and the respawned
// monitor re-baselines them from a fresh dump.
//
// Over-masking is accepted for sharing (a camera grab counts too —
// that ambiguity is exactly what cameraUsers then refines). Ambient
// grabbers with no audience (a Hue light sync) are ignored in both:
// the universal ones in ALWAYS_IGNORED below, personal ones in
// [screen_share] ignore_apps.
//
// Mask journal lines keep the "screenShare:" prefix — that is the
// name `wam screen-share` and the wiki document; indicator flips log
// as "captureWatch:".

const [sharing, setSharing] = createState(false)
export { sharing }

// who is recording the camera / the microphone, as of the latest
// dump. Apps, not a bare boolean, so the indicator tooltip can name
// the takers
export type CaptureUser = { app: string; node: string }

const [cameraUsers, setCameraUsers] = createState<CaptureUser[]>([])
const [micUsers, setMicUsers] = createState<CaptureUser[]>([])
export { cameraUsers, micUsers }

export const cameraActive = cameraUsers.as(users => users.length > 0)
export const micActive = micUsers.as(users => users.length > 0)

// grabs that never have viewers, whoever runs them — matched like
// ignore_apps (case-insensitive, against application.name and node.name;
// huenicorn's pw-stream sets only node.name). Additions need the same
// "ambient consumer, never an audience" justification
const ALWAYS_IGNORED = ["huenicorn", "huenicornstream"]

// the only pw object types whose changes can move a watched state
const NODE_TYPE = "PipeWire:Interface:Node"
const LINK_TYPE = "PipeWire:Interface:Link"

let debounce = 0
let monitor: Gio.Subprocess | null = null
// one evaluation in flight at a time: a slow pw-dump (big graphs) must
// not complete after a newer one and land a stale sharing state
let evaluating = false
let evaluateAgain = false

export type VideoInput = { app: string; node: string; media: string }

// The slice of a pw-dump this module needs: nodes with the props that
// classify them, and the links between them. Links are recognized by
// their props (link.output.node / link.input.node) rather than by
// object type — that keeps test dumps to bare {id, info} shapes.
// Exported for tests.
export type PwNode = {
    id: number
    mediaClass: string
    // device.id of the Device object a source belongs to — "" for the
    // virtual sources the screencast portal creates
    device: string
    // pw node state ("running" / "suspended" / "idle"); "" when the
    // dump omits it
    state: string
    app: string // application.name, "" when unset
    node: string // node.name, "" when unset
    media: string // media.name ?? node.description ?? ""
}
export type PwLink = { out: string; in: string }
export type PwGraph = { nodes: PwNode[]; links: PwLink[] }

export function parseGraph(dump: string): PwGraph | null {
    try {
        const objects = JSON.parse(dump) as {
            id?: number
            info?: { props?: Record<string, unknown>; state?: string }
        }[]
        const nodes: PwNode[] = []
        const links: PwLink[] = []
        for (const o of objects) {
            const props = o?.info?.props
            if (!props) continue
            // link node refs arrive as JSON numbers on some PipeWire
            // versions and strings on others — accept both
            const out = props["link.output.node"]
            const input = props["link.input.node"]
            if (
                (typeof out === "string" || typeof out === "number") &&
                (typeof input === "string" || typeof input === "number")
            ) {
                links.push({ out: String(out), in: String(input) })
            } else {
                nodes.push({
                    id: o.id ?? -1,
                    mediaClass: String(props["media.class"] ?? ""),
                    device: String(props["device.id"] ?? ""),
                    state: String(o.info?.state ?? ""),
                    app: String(props["application.name"] ?? ""),
                    node: String(props["node.name"] ?? ""),
                    media: String(props["media.name"] ?? props["node.description"] ?? ""),
                })
            }
        }
        return { nodes, links }
    } catch {
        return null
    }
}

// The video-input streams of a parsed graph.
export function videoInputsOf(graph: PwGraph): VideoInput[] {
    return graph.nodes
        .filter(n => n.mediaClass === "Stream/Input/Video")
        .map(n => ({ app: n.app, node: n.node, media: n.media }))
}

// The video-input streams in a pw-dump, or null when the dump does not
// parse — exported for tests. Props can be sparse: a pw-stream client
// may set node.name without application.name (both are matched against
// screen_share.ignore_apps)
export function parseVideoInputs(dump: string): VideoInput[] | null {
    const graph = parseGraph(dump)
    return graph && videoInputsOf(graph)
}

// Who is capturing what in a parsed graph:
//
//   camera — a video-input stream LINKED to a Video/Source that
//     belongs to a device (v4l2, libcamera). Portal screencasts grab
//     virtual sources, which carry no device.id, so a call with the
//     camera on lights the camera indicator while a cast does not.
//     A stream with no link yet (portal negotiation) is not camera —
//     the mask already covers that ambiguous window.
//   mic — a stream linked to an Audio/Source or Audio/Source/Virtual.
//     A link from an Audio/Sink is a desktop-audio capture (the
//     sink's monitor ports), not the mic.
//
// Streams in a non-running state are neither: suspended/idle means
// the stream has released or never engaged its source. A dump that
// omits node state counts the stream — an indicator must not hide a
// recording it cannot classify. Exported for tests.
export function captureUsersOf(graph: PwGraph): { camera: CaptureUser[]; mic: CaptureUser[] } {
    const byId = new Map(graph.nodes.map(n => [String(n.id), n]))
    // stream id -> the source nodes it is linked from
    const sourcesOf = new Map<string, PwNode[]>()
    for (const link of graph.links) {
        const source = byId.get(link.out)
        if (!source) continue
        const sources = sourcesOf.get(link.in)
        if (sources) sources.push(source)
        else sourcesOf.set(link.in, [source])
    }
    const user = (n: PwNode): CaptureUser => ({ app: n.app, node: n.node })

    const camera: CaptureUser[] = []
    const mic: CaptureUser[] = []
    for (const n of graph.nodes) {
        if (n.mediaClass !== "Stream/Input/Video" && n.mediaClass !== "Stream/Input/Audio") continue
        if (n.state !== "" && n.state !== "running") continue
        const sources = sourcesOf.get(String(n.id)) ?? []
        if (n.mediaClass === "Stream/Input/Video") {
            if (sources.some(s => s.mediaClass === "Video/Source" && s.device !== ""))
                camera.push(user(n))
        } else if (
            sources.some(
                s => s.mediaClass === "Audio/Source" || s.mediaClass === "Audio/Source/Virtual",
            )
        ) {
            mic.push(user(n))
        }
    }
    return { camera, mic }
}

// captureUsersOf on a raw dump, null when it does not parse —
// exported for tests
export function parseCaptureUsers(dump: string): {
    camera: CaptureUser[]
    mic: CaptureUser[]
} | null {
    const graph = parseGraph(dump)
    return graph && captureUsersOf(graph)
}

// pw-dump -m prints the initial state as one pretty-printed JSON
// array, then each graph change as another small array. Node and Link
// changes are the only ones that can alter the watched states —
// Client/Port/Device/Metadata churn cannot (a device or profile
// switch re-creates its nodes, and those announce themselves). This
// matters because the one-shot `pw-dump` that evaluate() spawns is
// ITSELF graph churn — its client is added, then removed — and
// without a filter the watcher re-dumps itself forever: one full dump
// per debounce period, seen as ~3 pw-dump spawns/second at idle.
//
// Object REMOVALS are anonymous ({id, info: null}, no type field), so
// the router keeps an id -> type map from every complete burst and
// consults it for removals; an unclassifiable removal schedules
// anyway — a change we cannot read must not silently strand a state.
export function graphBurstRouter(schedule: () => void): {
    onLine(line: string): void
    reset(): void
} {
    let buffer = ""
    let depth = 0
    const types = new Map<string, string>()

    return {
        onLine(line: string) {
            buffer += `${line}\n`
            depth += bracketDepth(line)
            if (depth > 0) return
            const burst = buffer
            buffer = ""
            let objects: {
                id?: number
                type?: string
                info?: unknown
            }[]
            try {
                objects = JSON.parse(burst)
            } catch {
                schedule() // unreadable burst — cannot know, re-read
                return
            }
            let relevant = false
            for (const o of objects) {
                const id = String(o?.id ?? "")
                if (o?.info === null) {
                    // removal: type only from the map
                    const known = types.get(id)
                    types.delete(id)
                    if (known === undefined || known === NODE_TYPE || known === LINK_TYPE)
                        relevant = true
                } else {
                    if (typeof o?.type === "string") types.set(id, o.type)
                    if (o?.type === NODE_TYPE || o?.type === LINK_TYPE) relevant = true
                }
            }
            if (relevant) schedule()
        },
        reset() {
            buffer = ""
            depth = 0
            types.clear()
        },
    }
}

// net depth of `[`/`]` in s, ignoring brackets inside JSON strings —
// a burst is complete when the depth returns to zero
function bracketDepth(s: string): number {
    let depth = 0
    let inString = false
    let escaped = false
    for (const ch of s) {
        if (inString) {
            if (escaped) escaped = false
            else if (ch === "\\") escaped = true
            else if (ch === '"') inString = false
        } else if (ch === '"') inString = true
        else if (ch === "[") depth++
        else if (ch === "]") depth--
    }
    return depth
}

// ignoreApps is already lowercased (src/config.ts) — exported for tests
function matchesIgnore(app: string, node: string, ignoreApps: string[]): boolean {
    const a = app.toLowerCase()
    const n = node.toLowerCase()
    return [...ALWAYS_IGNORED, ...ignoreApps].some(i => i === a || i === n)
}

export function ignoredVideoInput(v: VideoInput, ignoreApps: string[]): boolean {
    return matchesIgnore(v.app, v.node, ignoreApps)
}

// the ignore list means "never a privacy event from this app", so it
// silences the camera dot the same way it silences the mask —
// exported for tests
export function ignoredCaptureUser(u: CaptureUser, ignoreApps: string[]): boolean {
    return matchesIgnore(u.app, u.node, ignoreApps)
}

function describe(v: VideoInput): string {
    return `${v.app || v.node || "unknown"} (${v.media || "?"})`
}

// short form for indicator tooltips and flip logs
export function describeUsers(users: CaptureUser[]): string {
    return users.map(u => u.app || u.node || "unknown").join(", ")
}

// indicator state update with flip diagnostics, the counterpart of the
// mask's below: a grab that appears and vanishes between polls is gone
// before anyone can inspect the graph, so the journal is the record
// (prefixed captureWatch: — the mask's lines stay screenShare:)
function setUsers(
    current: Accessor<CaptureUser[]>,
    set: (users: CaptureUser[]) => void,
    next: CaptureUser[],
    what: string,
) {
    const prev = current.get()
    if (
        prev.length === next.length &&
        prev.every((p, i) => p.app === next[i].app && p.node === next[i].node)
    )
        return
    console.warn(
        next.length > 0
            ? `captureWatch: ${what} in use — ${describeUsers(next)}`
            : `captureWatch: ${what} released`,
    )
    set(next)
}

async function evaluate() {
    if (evaluating) {
        evaluateAgain = true
        return
    }
    evaluating = true
    try {
        const out = await execAsync(["pw-dump"])
        const graph = parseGraph(out)

        // the mask: unchanged over-masking rule — ANY video-input
        // stream counts. An unparseable dump must not silently
        // unmask: fall back to the raw count, which knows nothing
        // about the ignore list
        const active = graph
            ? videoInputsOf(graph).filter(v => !ignoredVideoInput(v, Config.screenShare.ignoreApps))
            : null
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

        // the indicators: a dump that does not parse leaves the last
        // known state (header note: why not fail closed here)
        if (graph) {
            const users = captureUsersOf(graph)
            // the ignore list filters the camera users too —
            // "never a privacy event from this app"
            setUsers(
                cameraUsers,
                setCameraUsers,
                users.camera.filter(u => !ignoredCaptureUser(u, Config.screenShare.ignoreApps)),
                "camera",
            )
            setUsers(micUsers, setMicUsers, users.mic, "microphone")
        }
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
const burstRouter = graphBurstRouter(() => scheduleEvaluate())

function spawnMonitor() {
    // a monitor that died mid-dump leaves a half-read burst in the
    // router; the next monitor's initial dump must not merge with it
    burstRouter.reset()
    monitor = streamLines(
        ["pw-dump", "-m"],
        line => {
            // a respawned monitor produced output: back off from scratch
            respawnDelay = 5_000
            burstRouter.onLine(line)
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
    }
    // no immediate baseline evaluate here: pw-dump -m prints its full
    // state on connect, and that initial dump is a relevant burst — it
    // schedules one evaluate on its own. Calling evaluate() here too
    // doubled a full dump on every (re)spawn for a ~300ms head start
}

// started by the consumers: the Harvest panel pill and the media mask
// (hide_when_screen_sharing), plus the bar's privacy indicators — the
// camera dot and the mic blink must work even when nothing masks.
// Idempotent: the watcher runs while any consumer is alive, which for
// the indicators means always
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
registerDispose("captureWatch", dispose)
