import GLib from "gi://GLib?version=2.0"
import { execAsync, timeoutAdd, sourceRemove } from "../../metrics"
import { createState } from "gnim"
import { registerDispose } from "../../lifecycle"
import { backends, registerBackend } from "../registry"
import { stateLabel, type VpnBackend, type VpnStatus } from "../types"
import { isVpnType, resolveStatus, type NmProfileRef } from "../nm/parse"
import * as watch from "../nm/watch"
import type { NmSnapshot } from "../nm/watch"

// The generic NetworkManager backend: any VPN-type NM profile a vendor
// backend has not claimed. Status rides the shared NM watch (../nm —
// one monitor for every NM-backed backend); actions go straight to
// nmcli, which is re-entrant (a D-Bus client, not a stateful CLI), so
// unlike mullvad there is no command queue here — only `busy` tracking
// around up/down so the pane's switches go insensitive mid-activation.

const [status, setStatus] = createState<VpnStatus>({
    state: "disconnected",
    stateLabel: "Disconnected",
    server: "",
})
const [profiles, setProfiles] = createState<NmProfileRef[]>([])
// uuid of the profile currently up or activating — the location picker's
// "current" marker, and disconnect()'s target
const [currentUuid, setCurrentUuid] = createState("")
const [busy, setBusy] = createState(false)

// the profile uuid `connect()` activates: the last one seen active or
// picked, else the first in the list
let lastUuid = ""

// a failed `connection up` leaves nothing behind for a re-read to see,
// so the next monitor line ("device removed") would stomp the Failed
// word straight back to Disconnected. Hold it briefly instead
let failedUntil = 0

// action generations: a down the USER issued aborts any up started
// before it, and an aborted up must not report "Failed" for being
// cancelled (its `connection up` does return an error — that is what
// deactivating mid-activation looks like from the caller's side)
let actionSeq = 0
let abortedSeq = 0

// dedupe before notifying: snapshots arrive rebuilt from scratch, so
// identity alone would re-notify on every change
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

let lastProfiles: NmProfileRef[] = []
function applyProfiles(next: NmProfileRef[]) {
    if (
        next.length === lastProfiles.length &&
        next.every((p, i) => p.uuid === lastProfiles[i].uuid && p.name === lastProfiles[i].name)
    )
        return
    lastProfiles = next
    setProfiles(next)
}

// a VPN-type profile no VENDOR backend claims. Claimed ones (proton's
// "ProtonVPN <server>", created on every connect) are that backend's
// tunnel — listing them here too would show the same tunnel twice
function owned(name: string, type: string): boolean {
    return (
        isVpnType(type) && !backends.some(b => b.id !== "networkmanager" && b.claimsProfile?.(name))
    )
}

function onSnapshot(snap: NmSnapshot) {
    const mine = snap.connections.filter(c => owned(c.name, c.type))
    const list: NmProfileRef[] = mine.map(c => ({ name: c.name, uuid: c.uuid }))
    applyProfiles(list)
    const resolved = resolveStatus(
        list,
        mine.filter(c => c.device).map(c => ({ uuid: c.uuid, device: c.device })),
        snap.devices,
    )
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
        stateLabel: stateLabel(resolved.state),
        server: resolved.server,
    })
}

watch.subscribe(onSnapshot)

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
        .then(() => watch.refresh())
        .catch(() => {
            if (seq <= abortedSeq) {
                // the user aborted this attempt; that is not a failure
                watch.refresh()
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
                watch.refresh()
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

// one-shot re-read armed when an activation fails (see doUp)
let failSource = 0

// convention for lib modules with long-lived sources (see AGENTS.md).
// The watch has its own teardown; this is only the failhold timer
function dispose() {
    if (failSource) {
        sourceRemove(failSource)
        failSource = 0
    }
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
    // is re-entrant, so a down concurrent with an up is legal — and the
    // down DOES abort a mid-flight activation. currentUuid is empty for
    // the first beat of our own attempt (the device has not appeared
    // for the watch yet), so fall back to the attempt's target
    disconnect: () => {
        const uuid = currentUuid.get() || lastUuid
        if (!uuid) return
        abortedSeq = actionSeq
        setBusy(true)
        applyStatus({ state: "disconnecting", stateLabel: "Disconnecting", server: "" })
        execAsync(["nmcli", "connection", "down", uuid])
            // refresh on failure too: the tunnel may in fact be down
            .then(() => watch.refresh())
            .catch(() => watch.refresh())
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
        ensure: () => watch.refresh(),
        current: currentUuid,
    },
    refreshPane: () => watch.refresh(),
    busy,
}

registerBackend(backend)

// tear-down entry point, run from app.tsx on shutdown (lib/lifecycle)
registerDispose("vpn:networkmanager", dispose)

export default backend
