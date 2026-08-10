import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { execAsync, timeoutAdd, timeoutAddSeconds, sourceRemove } from "../../metrics"
import { streamLines } from "../../streamLines"
import { registerDispose } from "../../lifecycle"
import { parseConnections, parseDevices, type NmConnection, type NmDevice } from "./parse"

// The single NetworkManager watch every NM-backed VPN backend shares.
// `nmcli monitor` streams every device and profile change; each one
// funnels into a debounced re-read of the two terse listings (connection
// list with devices, device states), and a CHANGED snapshot wakes the
// subscribers. The 15s poll is the fallback for when the monitor can't
// run (no session bus, NM down).
//
// Shared, rather than one monitor per backend, because every consumer
// wants the same two listings: a machine with Mullvad, Proton and a
// bare NM profile would otherwise run three monitors and three sets of
// execs for one event. Spawns at import — the lib/vpn barrel imports
// the backends, which import this.
//
// nmcli is re-entrant (it is a D-Bus client, not a stateful CLI), so
// there is no command queue here; the backends serialise their own
// actions.

export interface NmSnapshot {
    connections: NmConnection[]
    devices: NmDevice[]
}

/** nmcli in PATH — probed once, it does not appear mid-session. When
 *  false, no subscriber ever fires */
export const available = GLib.find_program_in_path("nmcli") !== null

const subscribers: ((snap: NmSnapshot) => void)[] = []

/** called with the latest snapshot after every change. No initial call:
 *  the first refresh lands within a second of import, and a subscriber
 *  that needs state NOW should call refresh() itself */
export function subscribe(cb: (snap: NmSnapshot) => void): void {
    subscribers.push(cb)
}

// dedupe before notifying: a refresh rebuilds both lists from scratch,
// so identity alone would wake every subscriber on every monitor line
const EMPTY: NmSnapshot = { connections: [], devices: [] }
let last = EMPTY

function sameSnapshot(a: NmSnapshot, b: NmSnapshot): boolean {
    return (
        a.connections.length === b.connections.length &&
        a.connections.every(
            (c, i) =>
                c.uuid === b.connections[i].uuid &&
                c.name === b.connections[i].name &&
                c.device === b.connections[i].device,
        ) &&
        a.devices.length === b.devices.length &&
        a.devices.every(
            (d, i) =>
                d.device === b.devices[i].device &&
                d.state === b.devices[i].state &&
                d.connection === b.devices[i].connection,
        )
    )
}

// skip overlapping refreshes: two execs per run, and a monitor burst
// that slipped past the debounce must not stack them
let refreshing = false
let refreshQueued = false

/** a re-read right now. Backends call this after their own actions and
 *  on pane open; monitor events come through the debounce below */
export async function refresh() {
    if (!available) return
    if (refreshing) {
        refreshQueued = true
        return
    }
    refreshing = true
    lastRefresh = Date.now()
    try {
        const [connOut, deviceOut] = await Promise.all([
            // ONE listing for profiles and active set alike: the plain
            // form already prints the device column (empty when
            // inactive), so a separate --active call would be a second
            // spawn per refresh for the same rows
            execAsync(["nmcli", "-t", "-f", "NAME,UUID,TYPE,DEVICE", "connection", "show"]),
            execAsync(["nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status"]),
        ])
        const next: NmSnapshot = {
            connections: parseConnections(connOut),
            devices: parseDevices(deviceOut),
        }
        if (sameSnapshot(next, last)) return
        last = next
        for (const cb of subscribers) cb(next)
    } catch {
        // NM down or not answering: leave state as is
    } finally {
        refreshing = false
        if (refreshQueued) {
            refreshQueued = false
            refresh()
        }
    }
}

// a transition prints a burst of ~10 monitor lines; one refresh after
// the burst, not one per line. Events arriving hot on the heels of a
// refresh must not be DROPPED — the monitor's own banner line lands
// just after the explicit initial refresh, which is what the freshness
// gate is for — so the re-read is armed for the freshness boundary
// instead. Dropping it left the snapshot stale for good when the last
// event of a burst (a teardown completing) fell inside the window
let refreshSource = 0
let lastRefresh = 0
function scheduleRefresh() {
    if (refreshSource || disposed) return
    const wait = Math.max(300, 1000 - (Date.now() - lastRefresh))
    refreshSource = timeoutAdd("vpn-nm:refresh", GLib.PRIORITY_DEFAULT, wait, () => {
        refreshSource = 0
        refresh()
        return GLib.SOURCE_REMOVE
    })
}

let pollSource = 0
let listenProc: Gio.Subprocess | null = null
let disposed = false

function startPolling() {
    if (pollSource || disposed) return
    refresh()
    pollSource = timeoutAddSeconds("vpn-nm:poll", GLib.PRIORITY_DEFAULT, 15, () => {
        refresh()
        return GLib.SOURCE_CONTINUE
    })
}

// convention for lib modules with long-lived sources (see AGENTS.md)
function dispose() {
    disposed = true
    subscribers.length = 0
    if (pollSource) {
        sourceRemove(pollSource)
        pollSource = 0
    }
    if (refreshSource) {
        sourceRemove(refreshSource)
        refreshSource = 0
    }
    listenProc?.force_exit()
    listenProc = null
}

if (available) {
    // initial read; the monitor's own banner line would schedule one
    // anyway, but which line that is is nmcli's business, not ours
    refresh()
    // on unexpected exit (NM restart) fall back to the poll for the
    // rest of the session
    listenProc = streamLines(["nmcli", "monitor"], scheduleRefresh, startPolling, true)
    if (!listenProc) startPolling()
}

// tear-down entry point, run from app.tsx on shutdown (lib/lifecycle)
registerDispose("vpn:nmwatch", dispose)
