import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { execAsync, timeoutAddSeconds, sourceRemove } from "./metrics"
import { createState } from "gnim"
import { streamLines } from "./streamLines"

// Shared Mullvad VPN state. `mullvad status listen` streams tunnel
// state changes from one long-lived process; the 15s poll below is the
// fallback for when the listener can't run (old CLI, daemon down).
// Used by the bar indicator and the quick settings toggle.

export interface VpnStatus {
    connected: boolean
    relay: string
}

const [status, setStatus] = createState<VpnStatus>({ connected: false, relay: "" })

// both the stream and refreshVpn funnel through here; the stream feeds
// headers and detail lines separately, so dedupe before notifying
let lastConnected = false
let lastRelay = ""
function applyStatus(connected: boolean, relay: string) {
    if (connected === lastConnected && relay === lastRelay) return
    lastConnected = connected
    lastRelay = relay
    setStatus({ connected, relay })
}

// skip ticks while a previous refresh is still pending: a wedged
// mullvad daemon would otherwise accumulate one blocked process per tick
let refreshing = false
export async function refreshVpn() {
    if (refreshing) return
    refreshing = true
    try {
        const out = await execAsync(["mullvad", "status"])
        const connected = out.trimStart().startsWith("Connected")
        const relay = out.match(/Relay:\s*(\S+)/)?.[1] ?? ""
        applyStatus(connected, relay)
    } catch {
        // daemon down, leave state as is
    } finally {
        refreshing = false
    }
}

// probe once: no point spawning mullvad at all without one
export const hasMullvad = GLib.find_program_in_path("mullvad") !== null

// The listener prints the state block on start and on every tunnel
// state change. Blocks are not framed (no blank separators; same-state
// updates print only the changed detail lines), so track state per
// line: a known non-indented header sets connectivity, an indented
// "Relay:" line refines it.
const HEADER = /^(Connected|Connecting|Disconnecting|Disconnected|Blocked)/
function handleStatusLine(line: string) {
    const header = line.match(HEADER)
    if (header) {
        const connected = header[1] === "Connected"
        // Connected/Connecting blocks carry an indented Relay: line
        // right after; every other state has no relay worth keeping
        const keepRelay = connected || header[1] === "Connecting"
        applyStatus(connected, keepRelay ? lastRelay : "")
        return
    }
    // "(new)" variant: relay switched without a state transition
    const relay = line.match(/Relay(?: \(new\))?:\s*(\S+)/)
    if (relay) applyStatus(lastConnected, relay[1])
}

// 15s fallback: a VPN state change needs no 5s latency, but this spawns
// mullvad (a forked process) per tick, so the listener is preferred.
// refreshVpn is also called manually on connect/disconnect, so the
// indicator still flips promptly on user action.
let pollSource = 0
let listenProc: Gio.Subprocess | null = null
let disposed = false

function startPolling() {
    if (pollSource || disposed) return
    refreshVpn()
    pollSource = timeoutAddSeconds("vpn:poll", GLib.PRIORITY_DEFAULT, 15, () => {
        refreshVpn()
        return GLib.SOURCE_CONTINUE
    })
}

// convention for lib modules with long-lived sources (see AGENTS.md)
export function dispose() {
    disposed = true
    if (pollSource) {
        sourceRemove(pollSource)
        pollSource = 0
    }
    listenProc?.force_exit()
    listenProc = null
}

if (hasMullvad) {
    // on spawn failure or unexpected exit (daemon restart, CLI without
    // listen) fall back to the poll for the rest of the session
    const cmd = ["mullvad", "status", "listen"]
    listenProc = streamLines(cmd, handleStatusLine, startPolling)
    if (!listenProc) startPolling()
}

export default status
