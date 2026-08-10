import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { execAsync, timeoutAdd, timeoutAddSeconds, sourceRemove } from "../../metrics"
import { createState } from "gnim"
import { streamLines } from "../../streamLines"
import { registerDispose } from "../../lifecycle"
import { registerBackend } from "../registry"
import type { VpnBackend, VpnStatus } from "../types"
import { parseActive, parseDevices, parseProfiles, resolveStatus, type NmProfile } from "./parse"

// NetworkManager VPN backend. `nmcli monitor` streams every device and
// profile change; each one funnels into a debounced re-read of the two
// terse listings (connection list with devices, device states), which
// parse.ts folds into a status. The 15s poll below is the fallback for
// when the monitor can't run (no session bus, NM down). The parsers
// live next door in ./parse — no import-time side effects, so tests can
// reach them without starting a real monitor.
//
// nmcli is re-entrant (it is a D-Bus client, not a stateful CLI), so
// unlike mullvad there is no command queue here — only `busy` tracking
// around up/down so the pane's switches go insensitive mid-activation.

const [status, setStatus] = createState<VpnStatus>({
    state: "disconnected",
    stateLabel: "Disconnected",
    server: "",
})
const [profiles, setProfiles] = createState<NmProfile[]>([])
// uuid of the profile currently up or activating — the location picker's
// "current" marker, and disconnect()'s target
const [currentUuid, setCurrentUuid] = createState("")
const [busy, setBusy] = createState(false)

// probe once: nmcli does not appear mid-session
const hasNmcli = GLib.find_program_in_path("nmcli") !== null

// the profile uuid `connect()` activates: the last one seen active or
// picked, else the first in the list
let lastUuid = ""

// a failed `connection up` leaves nothing behind for refreshAll to see,
// so the next monitor line ("device removed") would stomp the Failed
// word straight back to Disconnected. Hold it briefly instead
let failedUntil = 0

// action generations: a down the USER issued aborts any up started
// before it, and an aborted up must not report "Failed" for being
// cancelled (its `connection up` does return an error — that is what
// deactivating mid-activation looks like from the caller's side)
let actionSeq = 0
let abortedSeq = 0

// dedupe before notifying: refreshAll rebuilds its lists from scratch,
// so identity alone would re-notify on every monitor line
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

const STATE_LABEL: Record<VpnStatus["state"], string> = {
    connected: "Connected",
    connecting: "Connecting",
    disconnecting: "Disconnecting",
    disconnected: "Disconnected",
    blocked: "Failed",
}

let lastProfiles: NmProfile[] = []
function applyProfiles(next: NmProfile[]) {
    if (
        next.length === lastProfiles.length &&
        next.every((p, i) => p.uuid === lastProfiles[i].uuid && p.name === lastProfiles[i].name)
    )
        return
    lastProfiles = next
    setProfiles(next)
}

// skip overlapping refreshes: two execs per run, and a monitor burst
// that slipped past the debounce must not stack them
let refreshing = false
let refreshQueued = false

async function refreshAll() {
    if (!hasNmcli) return
    if (refreshing) {
        refreshQueued = true
        return
    }
    refreshing = true
    lastRefresh = Date.now()
    try {
        const [profileOut, deviceOut] = await Promise.all([
            // ONE listing for profiles and active set alike: the plain
            // form already prints the device column (empty when
            // inactive), so a separate --active call would be a second
            // spawn per refresh for the same rows
            execAsync(["nmcli", "-t", "-f", "NAME,UUID,TYPE,DEVICE", "connection", "show"]),
            execAsync(["nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status"]),
        ])
        const list = parseProfiles(profileOut)
        applyProfiles(list)
        const resolved = resolveStatus(list, parseActive(profileOut), parseDevices(deviceOut))
        if (!resolved) {
            if (currentUuid.get()) setCurrentUuid("")
            if (Date.now() >= failedUntil)
                applyStatus({ state: "disconnected", stateLabel: "Disconnected", server: "" })
            return
        }
        if (currentUuid.get() !== resolved.uuid) setCurrentUuid(resolved.uuid)
        if (resolved.state === "connected") lastUuid = resolved.uuid
        applyStatus({
            state: resolved.state,
            stateLabel: STATE_LABEL[resolved.state],
            server: resolved.server,
        })
    } catch {
        // NM down or not answering: leave state as is
    } finally {
        refreshing = false
        if (refreshQueued) {
            refreshQueued = false
            refreshAll()
        }
    }
}

// a transition prints a burst of ~10 monitor lines; one refresh after
// the burst, not one per line. The monitor's own banner line arrives
// just after the explicit initial refresh — a refresh that fresh is
// skipped outright, or startup pays for the same read twice
let refreshSource = 0
let lastRefresh = 0
function scheduleRefresh() {
    if (refreshSource || disposed) return
    if (Date.now() - lastRefresh < 1000) return
    refreshSource = timeoutAdd("vpn-nm:refresh", GLib.PRIORITY_DEFAULT, 300, () => {
        refreshSource = 0
        refreshAll()
        return GLib.SOURCE_REMOVE
    })
}

let pollSource = 0
// one-shot re-read armed when an activation fails (see doUp)
let failSource = 0
let listenProc: Gio.Subprocess | null = null
let disposed = false

function startPolling() {
    if (pollSource || disposed) return
    refreshAll()
    pollSource = timeoutAddSeconds("vpn-nm:poll", GLib.PRIORITY_DEFAULT, 15, () => {
        refreshAll()
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
    if (refreshSource) {
        sourceRemove(refreshSource)
        refreshSource = 0
    }
    if (failSource) {
        sourceRemove(failSource)
        failSource = 0
    }
    listenProc?.force_exit()
    listenProc = null
}

if (hasNmcli) {
    // initial read; the monitor's own banner line would schedule one
    // anyway, but which line that is is nmcli's business, not ours
    refreshAll()
    // on unexpected exit (NM restart) fall back to the poll for the
    // rest of the session
    listenProc = streamLines(["nmcli", "monitor"], scheduleRefresh, startPolling, true)
    if (!listenProc) startPolling()
}

// ------------------------------------------------------ actions

// the up half of every action. `connection up` is synchronous — it
// returns once activation has completed OR failed — so there is no
// in-flight window to manage, only the result to classify
function doUp(uuid: string): Promise<void> {
    const seq = ++actionSeq
    applyStatus({
        state: "connecting",
        stateLabel: "Connecting",
        server: profiles.get().find(p => p.uuid === uuid)?.name ?? "",
    })
    return execAsync(["nmcli", "connection", "up", uuid])
        .then(() => refreshAll())
        .catch(() => {
            if (seq <= abortedSeq) {
                // the user aborted this attempt; that is not a failure
                refreshAll()
                return
            }
            failedUntil = Date.now() + 10_000
            applyStatus({ state: "blocked", stateLabel: "Failed", server: "" })
            // "Failed" is a notice, not a state NM will ever move us out
            // of: without a fresh event nothing re-reads, and the pill
            // would say Failed forever. Arm the re-read for when the
            // hold expires (tracked, like `expiring` in notifd)
            if (failSource) sourceRemove(failSource)
            failSource = timeoutAdd("vpn-nm:failhold", GLib.PRIORITY_DEFAULT, 10_000, () => {
                failSource = 0
                refreshAll()
                return GLib.SOURCE_REMOVE
            })
        })
}

function up(uuid: string) {
    if (!uuid || busy.get()) return
    lastUuid = uuid
    setBusy(true)
    doUp(uuid).finally(() => setBusy(false))
}

// down + up as one busy span: location switches, and reconnect. NM
// happily runs several VPNs at once, but the picker's semantics are
// "change", so the current tunnel comes down first
function changeTo(uuid: string) {
    if (!uuid || busy.get()) return
    lastUuid = uuid
    setBusy(true)
    const current = currentUuid.get()
    const downPhase = current
        ? execAsync(["nmcli", "connection", "down", current]).catch(() => {})
        : Promise.resolve()
    downPhase.then(() => doUp(uuid)).finally(() => setBusy(false))
}

// what connect() activates: the remembered profile when it still
// exists (profiles come and go at runtime), else the first in the list
function targetUuid(): string {
    const list = profiles.get()
    if (list.some(p => p.uuid === lastUuid)) return lastUuid
    return list[0]?.uuid ?? ""
}

const backend: VpnBackend = {
    id: "networkmanager",
    name: "NetworkManager",
    iconName: "network-vpn-symbolic",
    // re-derived on every profile change: an NM profile appears at
    // runtime when a vendor app creates one on first connect
    active: profiles.as(p => p.length > 0),
    status,

    // no-op when a tunnel is already up: `connection up` on an active
    // profile is an ERROR in nmcli, which would read as "Failed"
    connect: () => {
        if (!currentUuid.get()) up(targetUuid())
    },
    // never refused (no busy guard): this is also the only way to abort
    // an in-flight attempt, which the interface requires of it. nmcli
    // is re-entrant, so a down concurrent with an up is legal
    disconnect: () => {
        const uuid = currentUuid.get()
        if (!uuid) return
        abortedSeq = actionSeq
        setBusy(true)
        applyStatus({ state: "disconnecting", stateLabel: "Disconnecting", server: "" })
        execAsync(["nmcli", "connection", "down", uuid])
            // refresh on failure too: the tunnel may in fact be down
            .then(() => refreshAll())
            .catch(() => refreshAll())
            .finally(() => setBusy(false))
    },
    reconnect: () => changeTo(currentUuid.get() || targetUuid()),

    locations: {
        // each VPN profile IS a location: the picker doubles as the
        // profile switcher. Re-picking the current row is a no-op, not
        // a reconnect
        list: profiles.as(list =>
            list.map(p => ({
                id: p.uuid,
                label: p.name,
                select: () => {
                    if (p.uuid !== currentUuid.get()) changeTo(p.uuid)
                },
            })),
        ),
        ensure: () => refreshAll(),
        current: currentUuid,
    },
    refreshPane: () => refreshAll(),
    busy,
}

registerBackend(backend)

// tear-down entry point, run from app.tsx on shutdown (lib/lifecycle)
registerDispose("vpn:networkmanager", dispose)

export default backend
