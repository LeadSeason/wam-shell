import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { execAsync, timeoutAdd, sourceRemove } from "../../metrics"
import { Accessor, createComputed, createState } from "gnim"
import { registerDispose } from "../../lifecycle"
import { registerBackend } from "../registry"
import { stateLabel, type VpnBackend, type VpnStatus } from "../types"
import { resolveStatus } from "../nm/parse"
import * as watch from "../nm/watch"
import type { NmSnapshot } from "../nm/watch"
import {
    FEATURE_DEFS,
    featureOn,
    isProtonProfile,
    parseConfigList,
    parseCountries,
    serverCountryGuess,
    serverFromProfile,
    type ProtonCountry,
} from "./parse"

// Proton VPN backend (official app/CLI, protonvpn 1.0.x).
//
// Status needs NO protonvpn CLI calls: Proton manages its tunnel
// through NetworkManager (it creates a "ProtonVPN <server>" profile on
// connect and removes it on disconnect), so the shared NM watch sees
// everything — and at ~1.7s of Python startup per invocation, polling
// the CLI was never an option anyway. The CLI is only used for ACTIONS
// (connect/disconnect, config set) and pane-open fetches (config list,
// countries), each user-triggered.
//
// The CLI also prints a sentry_sdk EventletDeprecationWarning to stderr
// on every invocation; execAsync pipes stderr rather than inheriting
// it, so the log stays clean.

const [status, setStatus] = createState<VpnStatus>({
    state: "disconnected",
    stateLabel: "Disconnected",
    server: "",
})
const [countries, setCountries] = createState<ProtonCountry[]>([])
const [busy, setBusy] = createState(false)
// config list values by setting key, fetched on pane open
const [configValues, setConfigValues] = createState<Record<string, string>>({})

// probe once: the CLI does not appear mid-session
const hasProton = GLib.find_program_in_path("protonvpn") !== null

// the country `connect()` targets: the last one picked, else fastest
let lastCountry = ""

// a failed `protonvpn connect` leaves nothing behind for the watch to
// see, so the next NM event would stomp the Failed word straight back
// to Disconnected. Hold it briefly instead
let failedUntil = 0

// action generations: a disconnect the USER issued aborts any connect
// started before it, and an aborted connect must not report "Failed"
// for being cancelled
let actionSeq = 0
let abortedSeq = 0

// the in-flight `protonvpn connect` process, tracked so disconnect()
// can KILL it: the CLI is stateless and cannot cancel its own attempt,
// and a deferred abort leaves the tunnel up for the whole connect
// (several seconds — or for good, when the user only clicked Proton by
// accident while Mullvad's lockdown makes the attempt hopeless anyway)
let connectProc: Gio.Subprocess | null = null

// every Proton profile NM knew about at the last snapshot, so an abort
// can down the up ones: killing the CLI does not cancel an NM
// activation it already started, but `nmcli connection down` on an
// ACTIVATING profile does
let lastProton: { uuid: string; up: boolean }[] = []

function downAllProton() {
    for (const p of lastProton)
        if (p.up) execAsync(["nmcli", "connection", "down", "uuid", p.uuid]).catch(() => {})
}

// dedupe before notifying: snapshots arrive rebuilt from scratch
let lastStatus: VpnStatus = status.get()
function applyStatus(next: VpnStatus) {
    if (
        next.state === lastStatus.state &&
        next.stateLabel === lastStatus.stateLabel &&
        next.server === lastStatus.server
    )
        return
    lastStatus = next
    setStatus(next)
}

function onSnapshot(snap: NmSnapshot) {
    const mine = snap.connections.filter(c => isProtonProfile(c.name))
    lastProton = mine.map(c => ({ uuid: c.uuid, up: c.device !== "" }))
    const list = mine.map(c => ({ name: c.name, uuid: c.uuid }))
    const resolved = resolveStatus(
        list,
        mine.filter(c => c.device).map(c => ({ uuid: c.uuid, device: c.device })),
        snap.devices,
    )
    if (!resolved) {
        // an empty read must not stomp an in-flight attempt back to
        // Disconnected: NM only learns about the profile once the CLI
        // creates it, seconds into the connect — and disconnect()'s
        // guard takes this state at face value
        if (connectProc || Date.now() < failedUntil) return
        applyStatus({ state: "disconnected", stateLabel: "Disconnected", server: "" })
        return
    }
    // an in-flight attempt shows Connecting, full stop: protonvpn's own
    // activation bounces the device through a transient deactivating
    // mid-connect, and the watch's trailing refresh now SEES it — the
    // pill flashed "Disconnecting…" on the happy path. The CLI's exit
    // code decides the outcome; only an actually-up tunnel overrides
    const state = connectProc && resolved.state !== "connected" ? "connecting" : resolved.state
    applyStatus({
        state,
        stateLabel: stateLabel(state),
        server: serverFromProfile(resolved.server),
    })
}

watch.subscribe(onSnapshot)

// ------------------------------------------------------ actions

// the CLI's exit code is the result: connect/disconnect return once
// the tunnel is up or the attempt has failed. The watch picks the
// outcome up from NM either way; the refresh is for promptness.
// Spawned by hand (not execAsync) so an in-flight connect stays
// killable — metrics has no wrapper for this, same as nm/watch.ts
function runProton(args: string[], seq: number): Promise<void> {
    const proc = Gio.Subprocess.new(
        ["protonvpn", ...args],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    )
    if (args[0] === "connect") connectProc = proc
    const done = new Promise<void>((resolve, reject) =>
        proc.communicate_utf8_async(null, null, (_p, res) => {
            if (proc === connectProc) connectProc = null
            try {
                proc.communicate_utf8_finish(res)
                if (proc.get_successful()) resolve()
                // no exit status here: a killed process never exited,
                // and get_exit_status asserts WIFEXITED
                else reject(new Error(`protonvpn ${args[0]} failed`))
            } catch (e) {
                reject(e)
            }
        }),
    )
    return done
        .then(() => watch.refresh())
        .catch(() => {
            if (seq <= abortedSeq) {
                // the user aborted this attempt; that is not a failure
                watch.refresh()
                return
            }
            failedUntil = Date.now() + 10_000
            applyStatus({ state: "blocked", stateLabel: "Failed", server: "" })
            // "Failed" is a notice, not a state the watch will ever move
            // us out of on its own: arm the re-read for when the hold
            // expires (tracked, like `expiring` in notifd)
            if (failSource) sourceRemove(failSource)
            failSource = timeoutAdd("vpn-proton:failhold", GLib.PRIORITY_DEFAULT, 10_000, () => {
                failSource = 0
                watch.refresh()
                return GLib.SOURCE_REMOVE
            })
        })
}

function connect(args: string[] = []) {
    if (busy.get()) return
    const seq = ++actionSeq
    setBusy(true)
    applyStatus({ state: "connecting", stateLabel: "Connecting", server: "" })
    runProton(["connect", ...args], seq)
        .then(() => {
            // safety net for the race where disconnect()'s kill landed
            // just as the attempt exited 0: the tunnel came up behind
            // the abort. Keep the connect's own seq — this disconnect
            // IS the abort, so a failure here is benign (the tunnel is
            // already down) and must not flash "Failed"
            if (seq <= abortedSeq) return runProton(["disconnect"], seq)
        })
        .finally(() => setBusy(false))
}

const backend: VpnBackend = {
    id: "protonvpn",
    name: "Proton VPN",
    iconName: "protonvpn-symbolic",
    // a PATH probe, decided once: the CLI does not appear mid-session.
    // Signed-in-or-not is the pane's problem (a connect attempt fails
    // honestly as "Failed"), not the pill's
    active: new Accessor(() => hasProton),
    status,

    connect: () => {
        if (status.get().state !== "disconnected") return
        connect(lastCountry ? ["--country", lastCountry] : [])
    },
    // never refused (no busy guard): this is also the only way to abort
    // an in-flight attempt, which the interface requires of it — and
    // the abort is IMMEDIATE: the connect process is killed outright
    // (it cannot cancel itself), and every Proton profile NM knows is
    // downed, because killing the CLI does not cancel an activation it
    // already handed to NetworkManager (`nmcli connection down` on an
    // activating profile does). Failures are ignored throughout: an
    // abort that finds nothing to tear down is not a failure, and the
    // watch re-read shows the truth
    disconnect: () => {
        // no early return while a connect is in flight, whatever the
        // displayed state: killing it IS the disconnect then
        if (status.get().state === "disconnected" && !connectProc) return
        abortedSeq = actionSeq
        const killed = connectProc !== null
        if (connectProc) {
            connectProc.force_exit()
            connectProc = null
        }
        setBusy(true)
        applyStatus({ state: "disconnecting", stateLabel: "Disconnecting", server: "" })
        downAllProton()
        execAsync(["protonvpn", "disconnect"])
            .catch(() => {})
            .then(() => watch.refresh())
            .finally(() => {
                setBusy(false)
                // when the teardown changed nothing in NM — an aborted
                // attempt that never got as far as creating a profile,
                // e.g. killed while Mullvad's lockdown had the API
                // unreachable — no snapshot fires, and the dedupe means
                // the synthetic Disconnecting is never reverted
                if (!connectProc && !lastProton.some(p => p.up))
                    applyStatus({
                        state: "disconnected",
                        stateLabel: "Disconnected",
                        server: "",
                    })
            })
        if (killed) armAbortSweep()
    },
    reconnect: () => {
        if (busy.get()) return
        const args = lastCountry ? ["--country", lastCountry] : []
        if (status.get().state === "disconnected") {
            connect(args)
            return
        }
        const seq = ++actionSeq
        setBusy(true)
        runProton(["disconnect"], seq)
            .then(() => runProton(["connect", ...args], ++actionSeq))
            .finally(() => setBusy(false))
    },

    // Proton's NM profiles are this backend's tunnels — the generic NM
    // backend filters them out on this claim
    claimsProfile: isProtonProfile,

    locations: {
        // countries, not servers: the CLI offers no server catalogue
        // (`servers` prints a web link), and connect --country picks
        // the fastest server in it — the granularity the CLI has
        list: countries.as(list =>
            list.map(c => ({
                id: c.code,
                label: c.name,
                select: () => {
                    lastCountry = c.code
                    connect(["--country", c.code])
                },
            })),
        ),
        // fetched lazily on pane open; idempotent, and a failure (not
        // signed in) just leaves the list empty
        ensure: () => {
            if (!hasProton || countries.get().length > 0) return
            execAsync(["protonvpn", "countries", "list"])
                .then(out => setCountries(parseCountries(out)))
                .catch(() => {})
        },
        // a guess from the connected server's name, trusted only when
        // it names a country the CLI actually listed
        current: createComputed([status, countries], (s, list) => {
            const guess = serverCountryGuess(s.server)
            return list.some(c => c.code === guess) ? guess : ""
        }),
    },
    features: new Accessor(() =>
        FEATURE_DEFS.map(def => ({
            key: def.key,
            label: def.label,
            tooltip: def.tooltip,
            value: configValues.as(v => featureOn(v[def.key])),
            set: (on: boolean) => {
                if (busy.get()) return
                setBusy(true)
                execAsync(["protonvpn", "config", "set", def.key, on ? def.onValue : "off"])
                    .then(() => refreshPane())
                    .catch(() => {})
                    .finally(() => setBusy(false))
            },
        })),
    ),
    refreshPane,
    busy,
}

// fetched on pane open, not polled
function refreshPane() {
    if (!hasProton) return
    execAsync(["protonvpn", "config", "list"])
        .then(out => setConfigValues(parseConfigList(out)))
        .catch(() => {})
}

// one-shot re-read armed when an action fails (see runProton)
let failSource = 0

// a killed CLI cannot cancel an NM activation it already started: the
// tunnel can come up AFTER the kill, behind the abort, and stay up
// with nothing left to tear it down. Sweep once, late enough for that
// activation to have landed and the watch to have seen it
let abortSweepSource = 0
function armAbortSweep() {
    if (abortSweepSource) sourceRemove(abortSweepSource)
    abortSweepSource = timeoutAdd("vpn-proton:abortsweep", GLib.PRIORITY_DEFAULT, 3_000, () => {
        abortSweepSource = 0
        // a newer action owns the state now; not our tunnel to down
        if (abortedSeq < actionSeq) return GLib.SOURCE_REMOVE
        downAllProton()
        watch.refresh()
        return GLib.SOURCE_REMOVE
    })
}

// convention for lib modules with long-lived sources (see AGENTS.md)
function dispose() {
    if (failSource) {
        sourceRemove(failSource)
        failSource = 0
    }
    if (abortSweepSource) {
        sourceRemove(abortSweepSource)
        abortSweepSource = 0
    }
    connectProc?.force_exit()
    connectProc = null
}

registerBackend(backend)

// tear-down entry point, run from app.tsx on shutdown (lib/lifecycle)
registerDispose("vpn:protonvpn", dispose)

export default backend
