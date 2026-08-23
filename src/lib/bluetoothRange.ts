import Gio from "gi://Gio?version=2.0"
import GLib from "gi://GLib?version=2.0"
import { createState } from "gnim"
import { timeoutAdd, sourceRemove } from "./metrics"
import { registerDispose } from "./lifecycle"

// Which bluetooth devices are actually within reach right now.
//
// bluez answers this with RSSI: a device carries one while the adapter
// is hearing it. A paired device that is switched off, in its case or in
// another room simply has none — which is the whole difference between
// "paired, tap to connect" and "paired, but not here", and the pane had
// no way to show it.
//
// It cannot come from AstalBluetooth: `Device.rssi` is ALWAYS 0. The
// vala getter reads a cached proxy property that, for devices built by
// its ObjectManager client, never holds RSSI — measured against the same
// devices' raw bluez properties, where every one of them had a real
// value (-63, -77, -96 …) while astal reported 0 for all of them. So the
// pane's "sort by signal" was sorting by a constant, its slice(0, 8) was
// keeping an arbitrary eight rather than the closest eight, and the
// details row bound to `rssi !== 0` could never appear.
//
// Reading it off the bus directly costs three signal subscriptions, and
// only while something is actually looking (the pane holds a reference
// while it is open).

/** a device the adapter is currently hearing */
export interface Sighting {
    /** dBm, negative; closer to 0 is stronger */
    rssi: number
    /** monotonic microseconds, for the staleness sweep below */
    at: number
}

const [sightings, setSightings] = createState<Map<string, Sighting>>(new Map())
export { sightings }

/** in range with no RSSI of its own: a connected device is by
 *  definition within reach, and bluez publishes no RSSI for one */
const CONNECTED_RSSI = 0

// a device carried out of the room keeps its last reading until
// something ages it out — bluez says nothing when a device simply stops
// answering. A classic BR/EDR inquiry cycle is ~10s, so treat silence
// over four of them as gone
const STALE_US = 45_000_000
const SWEEP_MS = 15_000
// RSSI lands on every advertisement — dozens a second across a busy
// room. The pane re-sorts on each change, so batch them
const COALESCE_MS = 500

const pending = new Map<string, Sighting>()
const dropped = new Set<string>()
let flushTimer = 0
let sweepTimer = 0
let propsSub = 0
let addedSub = 0
let removedSub = 0
let refs = 0

function addressOf(path: string): string {
    return path.match(/\/dev_([0-9A-Fa-f_]+)$/)?.[1].replaceAll("_", ":") ?? ""
}

function flush() {
    if (!pending.size && !dropped.size) return
    const next = new Map(sightings.get())
    for (const [address, s] of pending) next.set(address, s)
    for (const address of dropped) next.delete(address)
    pending.clear()
    dropped.clear()
    setSightings(next)
}

function scheduleFlush() {
    if (flushTimer) return
    flushTimer = timeoutAdd("btRange:flush", GLib.PRIORITY_DEFAULT, COALESCE_MS, () => {
        flushTimer = 0
        flush()
        return GLib.SOURCE_REMOVE
    })
}

function see(address: string, rssi: number) {
    if (!address) return
    pending.set(address, { rssi, at: GLib.get_monotonic_time() })
    dropped.delete(address)
    scheduleFlush()
}

function unsee(address: string) {
    if (!address) return
    pending.delete(address)
    dropped.add(address)
    scheduleFlush()
}

function onProperties(
    _c: Gio.DBusConnection,
    _s: string | null,
    path: string,
    _i: string,
    _sig: string,
    params: GLib.Variant,
) {
    const address = addressOf(path)
    if (!address) return
    const changed = params.get_child_value(1)
    const rssi = changed.lookup_value("RSSI", null)
    if (rssi) see(address, rssi.get_int16())
    const connected = changed.lookup_value("Connected", null)
    if (connected?.get_boolean() && !rssi) see(address, CONNECTED_RSSI)

    // bluez also INVALIDATES RSSI, and that is deliberately ignored:
    // stopping a discovery invalidates it for every device at once,
    // measured — ten devices, ten invalidations, in the four seconds
    // after StopDiscovery. The pane stops discovery whenever it starts
    // a connect, so honouring those would empty the room the instant
    // someone clicked a device in it. Only the sweep below decides that
    // a device has gone, and it decides it from silence over time.
}

function onInterfacesAdded(
    _c: Gio.DBusConnection,
    _s: string | null,
    _p: string,
    _i: string,
    _sig: string,
    params: GLib.Variant,
) {
    // a device's FIRST reading arrives here, not in PropertiesChanged
    const address = addressOf(params.get_child_value(0).get_string()[0])
    if (!address) return
    const device = params.get_child_value(1).lookup_value("org.bluez.Device1", null)
    const rssi = device?.lookup_value("RSSI", null)
    if (rssi) see(address, rssi.get_int16())
}

function onInterfacesRemoved(
    _c: Gio.DBusConnection,
    _s: string | null,
    _p: string,
    _i: string,
    _sig: string,
    params: GLib.Variant,
) {
    unsee(addressOf(params.get_child_value(0).get_string()[0]))
}

/** one bluez signal match; `path`/`arg0` narrow it, null means any */
function subscribe(
    iface: string,
    member: string,
    path: string | null,
    arg0: string | null,
    handler: Gio.DBusSignalCallback,
): number {
    return Gio.DBus.system.signal_subscribe(
        "org.bluez",
        iface,
        member,
        path,
        arg0,
        Gio.DBusSignalFlags.NONE,
        handler,
    )
}

function sweep() {
    const now = GLib.get_monotonic_time()
    let stale = false
    for (const [address, s] of sightings.get()) {
        if (now - s.at <= STALE_US) continue
        dropped.add(address)
        stale = true
    }
    if (stale) scheduleFlush()
}

/**
 * Start tracking, and get back the release for it.
 *
 * Refcounted: the subscriptions exist only while a widget is watching,
 * and the table is cleared on the last release so a pane opened ten
 * minutes later does not start out believing a stale set of devices is
 * still in the room.
 */
export function acquireRange(): () => void {
    if (refs++ === 0) {
        const OM = "org.freedesktop.DBus.ObjectManager"
        propsSub = subscribe(
            "org.freedesktop.DBus.Properties",
            "PropertiesChanged",
            null,
            "org.bluez.Device1",
            onProperties,
        )
        addedSub = subscribe(OM, "InterfacesAdded", "/", null, onInterfacesAdded)
        removedSub = subscribe(OM, "InterfacesRemoved", "/", null, onInterfacesRemoved)
        sweepTimer = timeoutAdd("btRange:sweep", GLib.PRIORITY_DEFAULT, SWEEP_MS, () => {
            sweep()
            return GLib.SOURCE_CONTINUE
        })
    }
    let released = false
    return () => {
        if (released) return
        released = true
        if (--refs > 0) return
        dispose()
    }
}

// convention for lib modules with long-lived sources (see AGENTS.md)
export function dispose() {
    for (const sub of [propsSub, addedSub, removedSub]) {
        if (sub) Gio.DBus.system.signal_unsubscribe(sub)
    }
    propsSub = 0
    addedSub = 0
    removedSub = 0
    if (sweepTimer) {
        sourceRemove(sweepTimer)
        sweepTimer = 0
    }
    if (flushTimer) {
        sourceRemove(flushTimer)
        flushTimer = 0
    }
    pending.clear()
    dropped.clear()
    refs = 0
    setSightings(new Map())
}

// tear-down entry point, run from app.tsx on shutdown (lib/lifecycle)
registerDispose("bluetoothRange", dispose)
