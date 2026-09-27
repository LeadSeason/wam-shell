import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { Accessor, createComputed, createState } from "gnim"
import { execAsync, timeoutAddSeconds, sourceRemove } from "../../metrics"
import { registerDispose } from "../../lifecycle"
import { relTime } from "../../relTime"
import { streamLines } from "../../streamLines"
import { registerBackend } from "../registry"
import type {
    VpnAccount,
    VpnBackend,
    VpnDetails,
    VpnDevice,
    VpnFeature,
    VpnLocation,
    VpnNotice,
    VpnStatus,
} from "../types"
import {
    parseAccount,
    parseDetails,
    parseErrorText,
    parseExitNodes,
    parseFeatureCaps,
    parseHealth,
    parseLoggedOut,
    parseNetcheck,
    parsePeers,
    parsePrefs,
    parseStatusJson,
    derpCity,
    isAccessDenied,
    type TailscalePeer,
} from "./parse"

// Tailscale backend. The CLI has no follow/stream mode — `tailscale
// status --json` is a one-shot read — so this backend is poll-only,
// 15s, with a concurrency guard so a wedged tailscaled cannot pile up
// processes. Every status-document surface (state, exit nodes,
// account, details, devices) comes out of that one JSON document, so
// there is nothing else to fetch on the poll: locations.ensure() is
// just an early refresh. The feature toggles live in a second document
// (`tailscale get`), read only when the pane opens.
//
// Actions talk to the local tailscaled socket and block until applied,
// so they are plain concurrent execAsync with a busy counter (no
// command queue, unlike mullvad's non-reentrant CLI). up/down/set need
// root or operator rights: on a default install the command fails, the
// reason lands in the journal (stderr stays inherited), and the state
// simply does not flip — `sudo tailscale up --operator=$USER` is the
// one-time setup (docs/qSettings.md; the `set --operator` form the CLI
// suggests is broken upstream, tailscale/tailscale#18294).
//
// The parsers live next door in ./parse (no import-time side effects,
// so tests can reach them without starting a real poll).

const [status, setStatus] = createState<VpnStatus>({
    state: "disconnected",
    stateLabel: "Disconnected",
    server: "",
})

// both the poll and refresh-after-action funnel through here
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

const [exitNodes, setExitNodes] = createState<VpnLocation[]>([])
const [exitNodeCurrent, setExitNodeCurrent] = createState("")
const [devices, setDevices] = createState<VpnDevice[]>([])
const [account, setAccount] = createState<VpnAccount | null>(null)
const [details, setDetails] = createState<VpnDetails | null>(null)

// the yellow warning line under the status: daemon health (same
// document the poll already reads) + netcheck's blocking facts (active
// probes, ~5s — pane open only). Content-keyed so the 15s poll does not
// re-render the pane with a fresh array every tick
const [healthWarnings, setHealthWarnings] = createState<string[]>([])
const [udpBlocked, setUdpBlocked] = createState(false)
const [captivePortal, setCaptivePortal] = createState(false)
let lastHealthKey = ""
function applyHealth(next: string[]) {
    const key = next.join("\n")
    if (key === lastHealthKey) return
    lastHealthKey = key
    setHealthWarnings(next)
}

// the tracking form, not the deps-array form: both blocking flags start
// falsy, and the deps-array cache keys on falsy checks (AGENTS.md)
const warnings = createComputed(track => {
    const w = track(healthWarnings).slice()
    if (track(captivePortal)) w.push("Captive portal detected — sign in to the network first")
    if (track(udpBlocked)) w.push("UDP blocked — traffic flows through a relay")
    return w
})

/** the pane's device-row subline, composed at refresh time. OS and IP
 *  are static facts the status document carries for OFFLINE peers too
 *  — only the path (direct/relay) is online-only, and a down peer says
 *  when it was last seen instead. Offering an exit node is said either
 *  way. The daemon lower-cases some OS names ("linux") and display-cases
 *  others ("iOS") — even the lowercase ones out before they print */
function peerDevice(p: TailscalePeer): VpnDevice {
    const meta: string[] = []
    if (p.os) meta.push(p.os === p.os.toLowerCase() ? p.os[0]!.toUpperCase() + p.os.slice(1) : p.os)
    if (p.ip) meta.push(p.ip)
    if (p.online) {
        if (p.curAddr) meta.push("direct")
        else if (p.relay) meta.push(`relay ${derpCity(p.relay)}`)
    } else if (p.lastSeenMs !== null) {
        meta.push(`last seen ${relTime(p.lastSeenMs / 1000, Date.now() / 1000)}`)
    }
    if (p.exitNodeOption) meta.push("exit node")
    return {
        id: p.id,
        label: p.label,
        online: p.online,
        self: p.isSelf,
        copy: p.dnsName || p.ip,
        meta: meta.join(" · "),
    }
}

function setExitNode(id: string) {
    // "" clears the exit node; the picker's rows call this with the
    // node's tailscale IPv4
    runChain(["set", `--exit-node=${id}`])
}

// skip ticks while a previous refresh is still pending: a wedged
// tailscaled would otherwise accumulate one blocked process per tick
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
        const out = await execAsync(["tailscale", "status", "--json"])
        setLoggedOut(parseLoggedOut(out))
        applyHealth(parseHealth(out))
        const next = parseStatusJson(out)
        if (next) applyStatus(next)
        // one document feeds every surface; a state we cannot read keeps
        // the pane's cards at their last known values
        const nodes = parseExitNodes(out)
        if (nodes) {
            setExitNodes(nodes.list.map(n => ({ ...n, select: () => setExitNode(n.id) })))
            setExitNodeCurrent(nodes.current)
        }
        const acc = parseAccount(out)
        if (acc) setAccount(acc)
        const det = parseDetails(out)
        setDetails(det)
        const peers = parsePeers(out)
        if (peers) setDevices(peers.map(peerDevice))
        const caps = parseFeatureCaps(out)
        if (caps) {
            setSshAvailable(caps.ssh)
            setSshRuleIn(caps.sshRuleIn)
        }
    } catch (err) {
        // tailscaled down and logged-out both exit non-zero with the
        // reason on stderr; a failure no word parser claims keeps the
        // last state, like obscura's catch
        const parsed = parseErrorText(String(err))
        if (parsed) applyStatus(parsed)
    } finally {
        refreshing = false
        if (refreshQueued) {
            refreshQueued = false
            refreshStatus()
        }
    }
}

// probe once: no point spawning tailscale at all without one
const hasTailscale = GLib.find_program_in_path("tailscale") !== null
// the operator fix's escalation path: pkexec asks polkit, the session's
// agent (hyprpolkitagent etc.) draws the password dialog — the desktop
// answer to sudo's tty requirement. Absent it (or an agent), the fix
// button is not offered and the copy button remains the fallback
const hasPkexec = GLib.find_program_in_path("pkexec") !== null

let pollSource = 0
let disposed = false
// the status document's logged-out word, as of the last refresh: the
// pane reads it (VpnBackend.loggedOut) to offer Login alone and gray
// the last-known surfaces; connect/reconnect switch on it too
const [loggedOut, setLoggedOut] = createState(false)

function startPolling() {
    if (pollSource || disposed) return
    refreshStatus()
    pollSource = timeoutAddSeconds("vpn-tailscale:poll", GLib.PRIORITY_DEFAULT, 15, () => {
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
    loginProc?.force_exit()
    loginProc = null
    fixProc?.force_exit()
    fixProc = null
}

if (hasTailscale) startPolling()

// ------------------------------------------------------ actions

// the pane's switches and picker rows go insensitive while a command
// is in flight; the CLI blocks until the target state is reached, so
// the window is short, and the poll reports the truth regardless
const [busy, setBusy] = createState(false)
let inFlight = 0

// an action that failed for this reason has a one-time fix the user
// can run — name it in the pane instead of leaving the click looking
// dead (the journal is not where anyone looks first). The sentence
// names the PROBLEM, not the command: the pane offers the fix as a
// polkit button and a clipboard copy, so embedding the command in the
// text only crowded the row. `command` is the bare, pasteable spelling
// — and it is the `up --operator` form, NOT the `set --operator` the
// CLI itself suggests: set writes the pref but never takes effect
// (tailscale/tailscale#18294, live on this machine's 1.102.4), while
// up --operator grants control AND performs the login in one step
const OPERATOR_NOTICE: VpnNotice = {
    text: "Access denied — operator rights required.",
    command: "sudo tailscale up --operator=$USER",
    // one click beats copy-paste when polkit can carry it (see below)
    ...(hasPkexec ? { fix: { label: "Fix…", run: fixOperatorRights } } : {}),
}

// pkexec-granted run of the notice's own command, STREAMED: as root it
// is not denied, and `up` prints the auth URL and blocks when the node
// is logged out — piping the output lets the shell open the URL, so
// one click covers fix AND login. argv, never a shell: the operator
// name is expanded HERE (pkexec would not touch $USER), and nothing
// user-influenced can reach the command line. Only a clean exit clears
// the notice — a dismissed dialog or a failed up leaves it up
let fixProc: Gio.Subprocess | null = null
function fixOperatorRights() {
    if (fixProc || loginProc || disposed || !hasPkexec) return
    fixProc = streamLines(
        ["pkexec", "tailscale", "up", `--operator=${GLib.get_user_name()}`],
        line => {
            if (isAccessDenied(line)) {
                setNotice(OPERATOR_NOTICE)
                return
            }
            // not line-anchored — the CLI indents the URL (see the
            // auth flow above)
            const m = line.match(/https:\/\/\S+/)
            if (m) {
                try {
                    Gio.AppInfo.launch_default_for_uri(m[0], null)
                } catch (e) {
                    console.warn("vpn:tailscale: could not open the login URL:", e)
                }
            }
        },
        ok => {
            fixProc = null
            if (ok) setNotice(null)
            refreshStatus()
        },
        false,
        true,
    )
}
const [notice, setNotice] = createState<VpnNotice | null>(null)

function runChain(...cmds: string[][]) {
    if (!hasTailscale || disposed) return Promise.resolve()
    inFlight++
    setBusy(true)
    // per-chain outcome: any step succeeding proves the operator rights
    // are in place (a denial hits every write), so the notice clears;
    // a denial with no success is the missing-operator setup the pane
    // should name
    let succeeded = false
    let denied = false
    let chain: Promise<unknown> = Promise.resolve()
    // a failed step does not cancel the rest: reconnect must try its
    // up even when the down errored
    for (const args of cmds)
        chain = chain
            .then(() => execAsync(["tailscale", ...args]))
            .then(() => {
                succeeded = true
            })
            .catch(err => {
                if (isAccessDenied(String(err))) denied = true
            })
    return chain.finally(() => {
        inFlight--
        setBusy(inFlight > 0)
        if (succeeded) setNotice(null)
        else if (denied) setNotice(OPERATOR_NOTICE)
        refreshStatus()
    })
}

// ------------------------------------------------------ features

// the pane's Features card: set-flags worth flipping from a toggle,
// read back by `tailscale get --json` (unlike the status document,
// prefs are a second read — only on pane open, never on the poll).
// Values start null = "not read yet": the switches render insensitive
// rather than guessing
const [shieldsUp, setShieldsUp] = createState<boolean | null>(null)
const [acceptDns, setAcceptDns] = createState<boolean | null>(null)
const [acceptRoutes, setAcceptRoutes] = createState<boolean | null>(null)
const [runSSH, setRunSSH] = createState<boolean | null>(null)
// whether the tailnet offers Tailscale SSH at all (Self.CapMap's
// cap/ssh — tailcfg: "feature enabled/available"), and whether any SSH
// policy rule actually targets this machine (cap/ssh-rule-in). true
// until the first read: a switch locked before the daemon answers
// would look like a bug on the very first open
const [sshAvailable, setSshAvailable] = createState(true)
const [sshRuleIn, setSshRuleIn] = createState(false)

// the tracking form, not the deps-array form: sshRuleIn starts falsy,
// and the deps-array cache keys on falsy checks (AGENTS.md)
const sshDescription = createComputed(track => {
    if (!track(sshAvailable))
        return "Tailscale SSH is not enabled on this tailnet. Turn it on in the admin console."
    if (!track(sshRuleIn))
        return "No SSH rule targets this machine yet. Nobody can log in until one is added in the admin console."
    return "Accept SSH over the tailnet. The admin console decides who can log in."
})

async function refreshPrefs() {
    if (disposed || !hasTailscale) return
    try {
        const prefs = parsePrefs(await execAsync(["tailscale", "get", "--json"]))
        if (prefs) {
            setShieldsUp(prefs.shieldsUp)
            setAcceptDns(prefs.acceptDns)
            setAcceptRoutes(prefs.acceptRoutes)
            setRunSSH(prefs.runSSH)
        }
    } catch {
        // a failure keeps the last read values, like the status catch
    }
}

// netcheck does active probes (~5s) — pane open only, never the 15s
// poll. A failed run keeps the last verdict, like the prefs catch
async function refreshNetcheck() {
    if (disposed || !hasTailscale) return
    try {
        const r = parseNetcheck(await execAsync(["tailscale", "netcheck"]))
        setUdpBlocked(r.udpBlocked)
        setCaptivePortal(r.captivePortal)
    } catch {
        // a failure keeps the last verdict, like the status catch
    }
}

function setFlag(flag: string, on: boolean) {
    // the read-back rides the chain's finally so the switch only ever
    // reflects an applied value
    runChain(["set", `--${flag}=${on}`]).finally(() => refreshPrefs())
}

const featureList: VpnFeature[] = [
    {
        key: "shields-up",
        label: "Shields up",
        description:
            "Block all incoming connections, including ones already open. Outgoing still works.",
        value: shieldsUp,
        set: on => setFlag("shields-up", on),
    },
    {
        key: "accept-dns",
        label: "Accept DNS",
        description:
            "Resolve tailnet machine names on this machine. Other devices can still reach this one.",
        value: acceptDns,
        set: on => setFlag("accept-dns", on),
    },
    {
        key: "accept-routes",
        label: "Accept routes",
        description:
            "Use routes advertised by other devices, like a subnet router's LAN. No effect if none are advertised.",
        value: acceptRoutes,
        set: on => setFlag("accept-routes", on),
    },
    {
        key: "ssh",
        label: "Tailscale SSH",
        description: sshDescription,
        available: sshAvailable,
        // the server runs, but with no SSH rule targeting this machine
        // it admits nobody — a working toggle that does nothing yet
        attention: sshRuleIn.as(ruleIn => !ruleIn),
        value: runSSH,
        set: on => setFlag("ssh", on),
    },
]

// ------------------------------------------------------ login

let loginProc: Gio.Subprocess | null = null

// The auth flow's shared shape, for `tailscale login` (authenticate,
// tunnel stays down) and `tailscale up` on a logged-out node
// (authenticate AND bring the tunnel up — `up` blocks until the
// browser flow completes). The CLI prints the auth URL, then waits:
// the process is the waiter, kept alive until auth finishes
// (streamLines children are force-exited on shutdown). The URL carries
// a login token — it is launched, never logged.
//
// stderr is MERGED into the line stream, not silenced: without operator
// rights the CLI fast-fails with "Access denied: profiles access
// denied" on stderr and never prints the URL — a silenced stderr made
// that another dead click, and execAsync cannot be used at all (the
// captured output would swallow the URL and the promise would never
// settle).
//
// escalate: pkexec runs the same command as root, the session agent's
// password dialog in between — the login flow's first step is gated
// behind root/operator, so as the user the CLI is denied before it
// ever prints the auth URL
function startAuthFlow(args: string[], escalate = false) {
    if (loginProc || disposed || !hasTailscale) return
    let denied = false
    loginProc = streamLines(
        escalate && hasPkexec ? ["pkexec", "tailscale", ...args] : ["tailscale", ...args],
        line => {
            if (isAccessDenied(line)) {
                denied = true
                setNotice(OPERATOR_NOTICE)
                return
            }
            // the URL is never line-anchored: the CLI prints it indented
            // ("\thttps://…"), the status word inline ("Log in at:
            // https://…") — an anchored regex matched nothing and the
            // flow silently never opened a browser
            const m = line.match(/https:\/\/\S+/)
            if (m) {
                try {
                    Gio.AppInfo.launch_default_for_uri(m[0], null)
                } catch (e) {
                    console.warn("vpn:tailscale: could not open the login URL:", e)
                }
            }
        },
        () => {
            loginProc = null
            // a denial persists (the fix is the sudo command the notice
            // names); a clean exit means the flow went through, so an
            // older notice no longer applies
            if (!denied) setNotice(null)
            refreshStatus()
        },
        false,
        true,
    )
}

function login() {
    // logged out, the login flow needs root before the CLI will even
    // print the auth URL — pkexec carries it, and the streamed output
    // still lands the URL in a browser tab. Merely stopped, a non-root
    // re-auth attempt first (no password dialog for a likely no-op)
    startAuthFlow(["login"], loggedOut.get() && hasPkexec)
}

const backend: VpnBackend = {
    id: "tailscale",
    name: "Tailscale",
    iconName: "tailscale-symbolic",
    // a PATH probe, decided once: the CLI does not appear mid-session
    active: new Accessor(() => hasTailscale),
    status,

    // logged out, `tailscale up` prints the auth URL and blocks on the
    // browser flow — stream it (URL opened, denial surfaced) instead of
    // execAsync, where the URL would be swallowed and the chain would
    // hang until the user happened to auth blind
    connect: () => (loggedOut.get() ? startAuthFlow(["up"]) : runChain(["up"])),
    // tailscale up blocks until the tunnel is up (or the login prompt
    // fails), so a disconnect here is a plain teardown
    disconnect: () => runChain(["down"]),
    reconnect: () => (loggedOut.get() ? startAuthFlow(["up"]) : runChain(["down"], ["up"])),

    locations: {
        list: exitNodes,
        current: exitNodeCurrent,
        // every refresh reparses the catalogue from the same document,
        // so "fetch" is just an early poll — idempotent via the guard
        ensure: () => refreshStatus(),
    },
    account,
    details,
    devices,
    // the toggle SET is fixed; only their values change (the per-flag
    // states above), so a static list behind a read accessor
    features: new Accessor(() => featureList),

    // prefs and netcheck are second documents; read them only when the
    // pane is looked at (the poll never needs them)
    refreshPane: () => {
        refreshStatus()
        refreshPrefs()
        refreshNetcheck()
    },

    login,
    notice,
    loggedOut,
    warnings,

    busy,
}

registerBackend(backend)

// tear-down entry point, run from app.tsx on shutdown (lib/lifecycle)
registerDispose("vpn:tailscale", dispose)

export default backend
