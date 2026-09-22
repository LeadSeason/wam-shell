import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { Accessor, createState } from "gnim"
import { execAsync, timeoutAddSeconds, sourceRemove } from "../../metrics"
import { streamLines } from "../../streamLines"
import { registerDispose } from "../../lifecycle"
import { registerBackend } from "../registry"
import type { VpnBackend, VpnStatus } from "../types"
import { parseStatusLine } from "./parse"

// Obscura VPN backend. `obscura status --follow` streams the same summary
// lines the one-shot `status` prints, republished by the service on every
// state change; the 15s poll below is the fallback for when the stream
// cannot run (service down, old CLI). The service is a multi-client IPC
// server, so unlike mullvad's non-reentrant CLI the actions are plain
// concurrent execAsync — connect/disconnect block until the target state
// is reached and report the real state via the stream either way.
//
// No optional pane surfaces: the CLI offers no location picker (connect
// takes no location — the service picks the exit), no feature toggles,
// and the summary's account line carries no expiry date or device name.
//
// The CLI output parsers live next door in ./parse (no import-time side
// effects, so tests can reach them without starting a real stream).

const [status, setStatus] = createState<VpnStatus>({
    state: "disconnected",
    stateLabel: "Disconnected",
    server: "",
})

// both the stream and refreshStatus funnel through here; the service
// republishes the whole line set per change (the stream prints
// "VPN is disconnected." twice across a disconnect), so dedupe
let last: VpnStatus = status.get()
function applyStatus(next: VpnStatus) {
    if (
        next.state === last.state &&
        next.stateLabel === last.stateLabel &&
        next.server === last.server
    )
        return
    last = next
    setStatus(next)
}

function applyLine(line: string) {
    const parsed = parseStatusLine(line)
    if (parsed) applyStatus(parsed)
}

// skip ticks while a previous refresh is still pending: a wedged service
// would otherwise accumulate one blocked process per tick
let refreshing = false
// a refresh requested while one is in flight (e.g. right after the user
// clicked connect) must still land — the in-flight read started before
// the action took effect
let refreshQueued = false

async function refreshStatus() {
    // shutdown: an in-flight action's finally lands here mid-teardown —
    // spawning a fresh status read for a shell that is exiting helps no one
    if (disposed) return
    if (refreshing) {
        refreshQueued = true
        return
    }
    refreshing = true
    try {
        const out = await execAsync(["obscura", "status"])
        for (const line of out.split("\n")) applyLine(line)
    } catch (err) {
        // "Not logged in." (and any future summary-level failure) prints
        // on stderr with a non-zero exit: rejections carry it just as the
        // stream would. A service that is down prints something no line
        // parser claims — keep the last state, like mullvad's catch
        const parsed = parseStatusLine(String(err))
        if (parsed) applyStatus(parsed)
    } finally {
        refreshing = false
        if (refreshQueued) {
            refreshQueued = false
            refreshStatus()
        }
    }
}

// probe once: no point spawning obscura at all without one
const hasObscura = GLib.find_program_in_path("obscura") !== null

// 15s fallback: follow is preferred, but a stream that exits (service
// restart, CLI without --follow) must not leave the pill frozen.
// refreshStatus is also called after every action, so the indicator
// flips promptly on user action even between ticks
let pollSource = 0
let followProc: Gio.Subprocess | null = null
let disposed = false

function startPolling() {
    if (pollSource || disposed) return
    refreshStatus()
    pollSource = timeoutAddSeconds("vpn-obscura:poll", GLib.PRIORITY_DEFAULT, 15, () => {
        refreshStatus()
        return GLib.SOURCE_CONTINUE
    })
}

// convention for lib modules with long-lived sources (see AGENTS.md)
function dispose() {
    disposed = true
    if (pollSource) {
        sourceRemove(pollSource)
        pollSource = 0
    }
    followProc?.force_exit()
    followProc = null
}

if (hasObscura) {
    // stderr stays inherited (mullvad precedent): a permission or version
    // mismatch belongs in the journal, not silenced behind a quiet poll
    followProc = streamLines(["obscura", "status", "--follow"], applyLine, startPolling)
    if (!followProc) startPolling()
}

// ------------------------------------------------------ actions

// the pane's action buttons go insensitive while any command is in
// flight; the CLI blocks until the target state is reached, so the
// window is short, and the stream reports the truth regardless
const [busy, setBusy] = createState(false)
let inFlight = 0

function runChain(...cmds: string[][]) {
    if (!hasObscura || disposed) return
    inFlight++
    setBusy(true)
    let chain: Promise<unknown> = Promise.resolve()
    // a failed step does not cancel the rest: reconnect must try its
    // connect even when the disconnect errored
    for (const args of cmds)
        chain = chain.then(() => execAsync(["obscura", ...args])).catch(() => {})
    chain.finally(() => {
        inFlight--
        setBusy(inFlight > 0)
        refreshStatus()
    })
}

const backend: VpnBackend = {
    id: "obscura",
    name: "Obscura",
    iconName: "obscura-symbolic",
    // a PATH probe, decided once: the CLI does not appear mid-session
    active: new Accessor(() => hasObscura),
    status,

    connect: () => runChain(["connect"]),
    // no connect to abort mid-flight: connect only returns once the
    // tunnel is up, so a disconnect here is a plain teardown
    disconnect: () => runChain(["disconnect"]),
    reconnect: () => runChain(["disconnect"], ["connect"]),

    busy,
}

registerBackend(backend)

// tear-down entry point, run from app.tsx on shutdown (lib/lifecycle)
registerDispose("vpn:obscura", dispose)

export default backend
