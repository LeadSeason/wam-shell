import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { execAsync, timeoutAddSeconds, sourceRemove } from "../../metrics"
import { Accessor, createState } from "gnim"
import { streamLines } from "../../streamLines"
import { registerDispose } from "../../lifecycle"
import { registerBackend } from "../registry"
import {
    isConnected,
    type VpnAccount,
    type VpnBackend,
    type VpnDetails,
    type VpnFeature,
    type VpnLocation,
    type VpnStatus,
} from "../types"
import {
    STATE_WORDS,
    locationId,
    locationLabel,
    mapState,
    relayLocationId,
    parseAccountInfo,
    parseAutoConnect,
    parseDnsBlocking,
    parseLan,
    parseLockdown,
    parseRelayList,
    parseStatusVerbose,
    parseTunnelOptions,
} from "./parse"

// Mullvad VPN backend. `mullvad status listen` streams tunnel state
// changes from one long-lived process; the 15s poll below is the
// fallback for when the listener can't run (old CLI, daemon down).
// The CLI output parsers live next door in ./parse (no import-time side
// effects, so tests can reach them without starting a real listener).

const [status, setStatus] = createState<VpnStatus>({
    state: "disconnected",
    stateLabel: "Disconnected",
    server: "",
})

// both the stream and refreshStatus funnel through here; the stream
// feeds headers and detail lines separately, so dedupe before notifying
let last: VpnStatus = status.get()
function applyStatus(word: string, server: string) {
    const next: VpnStatus = { state: mapState(word), stateLabel: word, server }
    if (
        next.state === last.state &&
        next.stateLabel === last.stateLabel &&
        next.server === last.server
    )
        return
    last = next
    setStatus(next)
}

// skip ticks while a previous refresh is still pending: a wedged
// mullvad daemon would otherwise accumulate one blocked process per tick
let refreshing = false
// a refresh requested while one is in flight (e.g. right after the
// user clicked connect) must still land — the in-flight read started
// before the action took effect
let refreshQueued = false
const HEADER = new RegExp(`^(${STATE_WORDS})`)

async function refreshStatus() {
    if (refreshing) {
        refreshQueued = true
        return
    }
    refreshing = true
    try {
        const out = await execAsync(["mullvad", "status"])
        const word = out.trimStart().match(HEADER)?.[1] ?? last.stateLabel
        applyStatus(word, out.match(/Relay:\s*(\S+)/)?.[1] ?? "")
    } catch {
        // daemon down, leave state as is
    } finally {
        refreshing = false
        if (refreshQueued) {
            refreshQueued = false
            refreshStatus()
        }
    }
}

// probe once: no point spawning mullvad at all without one
const hasMullvad = GLib.find_program_in_path("mullvad") !== null

// The listener prints the state block on start and on every tunnel
// state change. Blocks are not framed (no blank separators; same-state
// updates print only the changed detail lines), so track state per
// line: a known non-indented header sets connectivity, an indented
// "Relay:" line refines it.
function handleStatusLine(line: string) {
    const header = line.match(HEADER)
    if (header) {
        // Connected/Connecting blocks carry an indented Relay: line
        // right after; every other state has no relay worth keeping
        const keepRelay = header[1] === "Connected" || header[1] === "Connecting"
        applyStatus(header[1], keepRelay ? last.server : "")
        return
    }
    // "(new)" variant: relay switched without a state transition
    const relay = line.match(/Relay(?: \(new\))?:\s*(\S+)/)
    if (relay) applyStatus(last.stateLabel, relay[1])
}

// 15s fallback: a VPN state change needs no 5s latency, but this spawns
// mullvad (a forked process) per tick, so the listener is preferred.
// refreshStatus is also called manually on connect/disconnect, so the
// indicator still flips promptly on user action.
let pollSource = 0
let listenProc: Gio.Subprocess | null = null
let disposed = false

function startPolling() {
    if (pollSource || disposed) return
    refreshStatus()
    pollSource = timeoutAddSeconds("vpn:poll", GLib.PRIORITY_DEFAULT, 15, () => {
        refreshStatus()
        return GLib.SOURCE_CONTINUE
    })
}

// convention for lib modules with long-lived sources (see AGENTS.md)
function dispose() {
    disposed = true
    // drop pending work: pump() refuses to spawn once disposed, and a
    // cleared queue means even an in-flight command's finally finds
    // nothing left to chain
    cmdQueue.length = 0
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
    listenProc = streamLines(["mullvad", "status", "listen"], handleStatusLine, startPolling)
    if (!listenProc) startPolling()
}

// ------------------------------------------------------ pane state

interface FeatureStates {
    quantum: boolean | null
    daita: boolean | null
    dnsBlock: boolean | null
    lan: boolean | null
    lockdown: boolean | null
    autoConnect: boolean | null
}

const [details, setDetails] = createState<VpnDetails | null>(null)
const [locationList, setLocationList] = createState<VpnLocation[]>([])
// account info (expiry + device name), fetched at most once a day
const [account, setAccount] = createState<VpnAccount | null>(null)
const [featureStates, setFeatureStates] = createState<FeatureStates>({
    quantum: null,
    daita: null,
    dnsBlock: null,
    lan: null,
    lockdown: null,
    autoConnect: null,
})
const [busy, setBusy] = createState(false)

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
    // disposed: shutdown — queued callbacks chain (a toggle's cb
    // enqueues six more commands), so without this gate commands keep
    // spawning mid-teardown
    if (disposed || cmdInFlight || cmdQueue.length === 0 || !hasMullvad) return
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
function refreshPane() {
    runCmd(["status", "-v"], out => {
        if (!out) return
        const v = parseStatusVerbose(out)
        // the parser's `features` list has no home in the shared shape:
        // the pane never rendered it, only the toggles below
        if (v)
            setDetails({
                server: v.relay,
                endpoint: v.endpoint,
                protocol: v.protocol,
                ip: v.ip,
                location: v.location,
            })
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
    refreshExpiry()
}

function setLocation(countryCode: string, cityCode: string) {
    runCmd(["relay", "set", "location", countryCode, cityCode], out => {
        if (out === null) return
        refreshStatus()
        refreshPane()
    })
}

// static per CLI version: parsed lazily once
function ensureLocations() {
    if (locationList.get().length > 0) return
    runCmd(["relay", "list"], out => {
        if (!out) return
        setLocationList(
            parseRelayList(out).map(l => ({
                id: locationId(l),
                label: locationLabel(l),
                select: () => setLocation(l.countryCode, l.cityCode),
            })),
        )
    })
}

let lastExpiryFetch = 0
function refreshExpiry() {
    if (Date.now() - lastExpiryFetch < 86_400_000) return
    runCmd(["account", "get"], out => {
        // stamp on SUCCESS only: a failed fetch must not burn the
        // once-a-day budget and leave the account line blank for 24h
        if (!out) return
        lastExpiryFetch = Date.now()
        setAccount(parseAccountInfo(out))
    })
}

function toggle(args: (on: boolean) => string[]): (on: boolean) => void {
    return on =>
        runCmd(args(on), out => {
            if (out !== null) refreshPane()
        })
}

// identities are stable, so the list itself never changes — only the
// values inside it, which are accessors of their own
const FEATURES: VpnFeature[] = [
    {
        key: "quantum",
        label: "Quantum Resistance",
        value: featureStates.as(f => f.quantum),
        set: toggle(on => ["tunnel", "set", "quantum-resistant", on ? "on" : "off"]),
    },
    {
        key: "daita",
        label: "DAITA",
        value: featureStates.as(f => f.daita),
        set: toggle(on => ["tunnel", "set", "daita", on ? "on" : "off"]),
    },
    {
        key: "dnsBlock",
        label: "DNS Content Blocker",
        value: featureStates.as(f => f.dnsBlock),
        set: toggle(on =>
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
        ),
    },
    {
        key: "lan",
        label: "LAN Sharing",
        value: featureStates.as(f => f.lan),
        set: toggle(on => ["lan", "set", on ? "allow" : "block"]),
    },
    {
        key: "lockdown",
        label: "Lockdown Mode",
        tooltip: "Blocks ALL traffic when the VPN disconnects, until you reconnect",
        value: featureStates.as(f => f.lockdown),
        set: toggle(on => ["lockdown-mode", "set", on ? "on" : "off"]),
    },
    {
        key: "autoConnect",
        label: "Auto-connect",
        value: featureStates.as(f => f.autoConnect),
        set: toggle(on => ["auto-connect", "set", on ? "on" : "off"]),
    },
]

const backend: VpnBackend = {
    id: "mullvad",
    name: "Mullvad",
    iconName: "mullvad-symbolic",
    iconNameDown: "mullvad-open-symbolic",
    // a PATH probe, decided once: the CLI does not appear mid-session
    active: new Accessor(() => hasMullvad),
    status,

    connect: () => runCmd(["connect"], () => refreshStatus()),
    // also aborts an in-flight attempt ("Connecting" state)
    disconnect: () => runCmd(["disconnect"], () => refreshStatus()),
    reconnect: () =>
        runCmd(["disconnect"], () => {
            runCmd(["connect"], () => refreshStatus())
        }),

    locations: {
        list: locationList,
        ensure: ensureLocations,
        current: status.as(s => (isConnected(s) ? relayLocationId(s.server) : "")),
    },
    features: new Accessor(() => FEATURES),
    account,
    details,
    refreshPane,
    busy,
}

registerBackend(backend)

// tear-down entry point, run from app.tsx on shutdown (lib/lifecycle)
registerDispose("vpn:mullvad", dispose)

export default backend
