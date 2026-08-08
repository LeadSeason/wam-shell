import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { execAsync, timeoutAddSeconds, sourceRemove } from "./metrics"
import { createState } from "gnim"
import { streamLines } from "./streamLines"
import { registerDispose } from "./lifecycle"

// Shared Mullvad VPN state. `mullvad status listen` streams tunnel
// state changes from one long-lived process; the 15s poll below is the
// fallback for when the listener can't run (old CLI, daemon down).
// Used by the bar indicator and the quick settings toggle.

export interface VpnStatus {
    connected: boolean
    relay: string
    // raw tunnel state word from `mullvad status`: "Connected",
    // "Connecting", "Disconnecting", "Disconnected", "Blocked"
    state: string
}

const [status, setStatus] = createState<VpnStatus>({
    connected: false,
    relay: "",
    state: "Disconnected",
})

// both the stream and refreshVpn funnel through here; the stream feeds
// headers and detail lines separately, so dedupe before notifying
let lastConnected = false
let lastRelay = ""
let lastState = "Disconnected"
function applyStatus(connected: boolean, relay: string, state: string) {
    if (connected === lastConnected && relay === lastRelay && state === lastState) return
    lastConnected = connected
    lastRelay = relay
    lastState = state
    setStatus({ connected, relay, state })
}

// skip ticks while a previous refresh is still pending: a wedged
// mullvad daemon would otherwise accumulate one blocked process per tick
let refreshing = false
// a refresh requested while one is in flight (e.g. right after the
// user clicked connect) must still land — the in-flight read started
// before the action took effect
let refreshQueued = false
export async function refreshVpn() {
    if (refreshing) {
        refreshQueued = true
        return
    }
    refreshing = true
    try {
        const out = await execAsync(["mullvad", "status"])
        const stateM = out
            .trimStart()
            .match(/^(Connected|Connecting|Disconnecting|Disconnected|Blocked)/)
        const connected = stateM?.[1] === "Connected"
        const relay = out.match(/Relay:\s*(\S+)/)?.[1] ?? ""
        applyStatus(connected, relay, stateM?.[1] ?? lastState)
    } catch {
        // daemon down, leave state as is
    } finally {
        refreshing = false
        if (refreshQueued) {
            refreshQueued = false
            refreshVpn()
        }
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
        applyStatus(connected, keepRelay ? lastRelay : "", header[1])
        return
    }
    // "(new)" variant: relay switched without a state transition
    const relay = line.match(/Relay(?: \(new\))?:\s*(\S+)/)
    if (relay) applyStatus(lastConnected, relay[1], lastState)
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

// ------------------------------------------------- pane data (F4)

export interface VerboseStatus {
    relay: string
    endpoint: string // "170.62.100.66:8306/UDP" (the "In" line)
    protocol: string // inferred from the relay id ("-wg-" = WireGuard)
    ip: string // exit IP (the "Out" line)
    location: string // "Sweden, Stockholm"
    features: string[] // ["DAITA", "Quantum Resistance", ...]
}

export function parseStatusVerbose(out: string): VerboseStatus | null {
    const relayM = out.match(/^\s*Relay:\s*(\S+) \((\S+)\)/m)
    if (!relayM) return null
    const features =
        out
            .match(/^\s*Features:\s*(.+)$/m)?.[1]
            ?.split(",")
            .map(s => s.trim())
            .filter(Boolean) ?? []
    const loc = out.match(/^\s*Visible location:\s*(.+?)\.\s*IPv4:\s*(\S+)/m)
    if (!loc) return null
    return {
        relay: relayM[1],
        endpoint: relayM[2],
        protocol: relayM[1].includes("-wg-") ? "WireGuard" : "OpenVPN",
        ip: loc[2],
        location: loc[1],
        features,
    }
}

export interface RelayLocation {
    country: string
    countryCode: string
    city: string
    cityCode: string
}

// "Albania (al)" / "\tTirana (tia) @ 41.3°N, 19.8°W" /
// "\t\tal-tia-wg-001 (...) - hosted by ..." — two indent levels:
// country, then city; double-indented relay lines are skipped
export function parseRelayList(out: string): RelayLocation[] {
    const locations: RelayLocation[] = []
    let country = "",
        countryCode = ""
    for (const line of out.split("\n")) {
        if (line.startsWith("\t\t")) continue // individual relays
        if (line.startsWith("\t")) {
            const m = line.match(/^\t(.+?) \((\w+)\) @/)
            if (m && country) {
                locations.push({ country, countryCode, city: m[1], cityCode: m[2] })
            }
        } else {
            const m = line.match(/^(.+?) \((\w+)\)\s*$/)
            if (m) {
                country = m[1]
                countryCode = m[2]
            }
        }
    }
    return locations
}

// "Mullvad account: 877...\nExpires at: 2027-03-18 09:15:40 +01:00\nDevice name: Stable Mole"
export function parseAccountInfo(out: string): { expiryMs: number | null; deviceName: string } {
    const m = out.match(/Expires at:\s*(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2}:\d{2})/)
    const t = m ? Date.parse(`${m[1]}T${m[2]}${m[3]}`) : NaN
    return {
        expiryMs: Number.isNaN(t) ? null : t,
        deviceName: out.match(/^\s*Device name:\s*(.+)$/m)?.[1]?.trim() ?? "",
    }
}

export function parseTunnelOptions(out: string): {
    quantum: boolean | null
    daita: boolean | null
} {
    const q = out.match(/Quantum resistance:\s*(\S+)/)?.[1]
    const d = out.match(/^\s*DAITA:\s*(\S+)/m)?.[1]
    return {
        quantum: q === undefined ? null : q === "on",
        daita: d === undefined ? null : d === "true",
    }
}

// any block flag on = the content blocker toggle is on
export function parseDnsBlocking(out: string): boolean | null {
    const flags = [
        ...out.matchAll(/^Block (?:ads|trackers|malware|adult content): (true|false)$/gm),
    ]
    if (flags.length === 0) return null
    return flags.some(f => f[1] === "true")
}

export function parseLan(out: string): boolean | null {
    const m = out.match(/Local network sharing setting: (allow|block)/)
    return m ? m[1] === "allow" : null
}

export function parseLockdown(out: string): boolean | null {
    const m = out.match(/Block traffic when the VPN is disconnected: (on|off)/)
    return m ? m[1] === "on" : null
}

export function parseAutoConnect(out: string): boolean | null {
    const m = out.match(/Autoconnect: (on|off)/)
    return m ? m[1] === "on" : null
}

// ------------------------------------------------------ pane state

export interface FeatureStates {
    quantum: boolean | null
    daita: boolean | null
    dnsBlock: boolean | null
    lan: boolean | null
    lockdown: boolean | null
    autoConnect: boolean | null
}

const [verbose, setVerbose] = createState<VerboseStatus | null>(null)
export { verbose }
const [locations, setLocations] = createState<RelayLocation[]>([])
export { locations }
// account info (expiry + device name), fetched at most once a day
const [accountInfo, setAccountInfo] = createState<{
    expiryMs: number | null
    deviceName: string
} | null>(null)
export { accountInfo }
const [featureStates, setFeatureStates] = createState<FeatureStates>({
    quantum: null,
    daita: null,
    dnsBlock: null,
    lan: null,
    lockdown: null,
    autoConnect: null,
})
export { featureStates }
const [busy, setBusy] = createState(false)
export { busy }

// one serialized queue for every mullvad invocation: the CLI is not
// re-entrant, and mashing toggles must not stack calls (harvest's
// mutate pattern, generalized to a queue so pane fetches aren't dropped)
interface Cmd {
    args: string[]
    cb: (out: string | null) => void
}
const cmdQueue: Cmd[] = []
let cmdInFlight = false

function pump() {
    if (cmdInFlight || cmdQueue.length === 0 || !hasMullvad) return
    cmdInFlight = true
    setBusy(true)
    const { args, cb } = cmdQueue.shift()!
    execAsync(["mullvad", ...args])
        .then(out => cb(out))
        .catch(() => cb(null))
        .finally(() => {
            cmdInFlight = false
            setBusy(cmdQueue.length > 0)
            pump()
        })
}

function runCmd(args: string[], cb: (out: string | null) => void) {
    cmdQueue.push({ args, cb })
    pump()
}

// fetched on pane open, not polled
export function refreshPaneData() {
    runCmd(["status", "-v"], out => {
        if (!out) return
        const v = parseStatusVerbose(out)
        if (v) setVerbose(v)
    })
    runCmd(["tunnel", "get"], out => {
        if (!out) return
        const { quantum, daita } = parseTunnelOptions(out)
        setFeatureStates({ ...featureStates.get(), quantum, daita })
    })
    runCmd(["dns", "get"], out => {
        if (!out) return
        setFeatureStates({ ...featureStates.get(), dnsBlock: parseDnsBlocking(out) })
    })
    runCmd(["lan", "get"], out => {
        if (!out) return
        setFeatureStates({ ...featureStates.get(), lan: parseLan(out) })
    })
    runCmd(["lockdown-mode", "get"], out => {
        if (!out) return
        setFeatureStates({ ...featureStates.get(), lockdown: parseLockdown(out) })
    })
    runCmd(["auto-connect", "get"], out => {
        if (!out) return
        setFeatureStates({ ...featureStates.get(), autoConnect: parseAutoConnect(out) })
    })
}

// static per CLI version: parsed lazily once
export function ensureLocations() {
    if (locations.get().length > 0) return
    runCmd(["relay", "list"], out => {
        if (out) setLocations(parseRelayList(out))
    })
}

let lastExpiryFetch = 0
export function refreshExpiry() {
    if (Date.now() - lastExpiryFetch < 86_400_000) return
    lastExpiryFetch = Date.now()
    runCmd(["account", "get"], out => {
        if (!out) return
        setAccountInfo(parseAccountInfo(out))
    })
}

export function setLocation(countryCode: string, cityCode: string) {
    runCmd(["relay", "set", "location", countryCode, cityCode], out => {
        if (out === null) return
        refreshVpn()
        refreshPaneData()
    })
}

export function setQuantum(on: boolean) {
    runCmd(["tunnel", "set", "quantum-resistant", on ? "on" : "off"], out => {
        if (out !== null) refreshPaneData()
    })
}

export function setDaita(on: boolean) {
    runCmd(["tunnel", "set", "daita", on ? "on" : "off"], out => {
        if (out !== null) refreshPaneData()
    })
}

export function setDnsBlock(on: boolean) {
    runCmd(
        on
            ? [
                  "dns",
                  "set",
                  "default",
                  "--block-ads",
                  "--block-trackers",
                  "--block-malware",
                  "--block-adult-content",
              ]
            : ["dns", "set", "default"],
        out => {
            if (out !== null) refreshPaneData()
        },
    )
}

export function setLan(on: boolean) {
    runCmd(["lan", "set", on ? "allow" : "block"], out => {
        if (out !== null) refreshPaneData()
    })
}

export function setLockdown(on: boolean) {
    runCmd(["lockdown-mode", "set", on ? "on" : "off"], out => {
        if (out !== null) refreshPaneData()
    })
}

export function setAutoConnect(on: boolean) {
    runCmd(["auto-connect", "set", on ? "on" : "off"], out => {
        if (out !== null) refreshPaneData()
    })
}

export function connect() {
    runCmd(["connect"], () => refreshVpn())
}

// also aborts an in-flight attempt ("Connecting" state)
export function disconnect() {
    runCmd(["disconnect"], () => refreshVpn())
}

export function reconnect() {
    runCmd(["disconnect"], () => {
        runCmd(["connect"], () => refreshVpn())
    })
}

export default status

// tear-down entry point, run from app.tsx on shutdown (lib/lifecycle)
registerDispose("vpn", dispose)
