import AstalBluetooth from "gi://AstalBluetooth?version=0.1"
import Gio from "gi://Gio?version=2.0"
import GLib from "gi://GLib?version=2.0"
import bluetooth from "../../../lib/bluetooth"
import { timeoutAdd, sourceRemove } from "../../../lib/metrics"

// AstalBluetooth's pair() and Adapter.remove_device() are SYNC D-Bus
// calls: they block the whole main loop, which froze the shell and
// queued agent prompts behind the block. Call bluez async instead.
function devicePath(device: AstalBluetooth.Device): string {
    return `${device.adapter}/dev_${device.address.replaceAll(":", "_")}`
}

function systemCallFinish(res: Gio.AsyncResult): void {
    Gio.DBus.system.call_finish(res)
}

export function pairDeviceAsync(device: AstalBluetooth.Device): Promise<void> {
    return new Promise((resolve, reject) => {
        Gio.DBus.system.call(
            "org.bluez",
            devicePath(device),
            "org.bluez.Device1",
            "Pair",
            null,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (_conn, res) => {
                try {
                    systemCallFinish(res)
                    resolve()
                } catch (e) {
                    reject(e)
                }
            },
        )
    })
}

export function removeDeviceAsync(device: AstalBluetooth.Device): void {
    Gio.DBus.system.call(
        "org.bluez",
        `${device.adapter}`,
        "org.bluez.Adapter1",
        "RemoveDevice",
        new GLib.Variant("(o)", [devicePath(device)]),
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (_conn, res) => {
            try {
                systemCallFinish(res)
            } catch (e) {
                console.warn("bluetooth forget failed:", e)
            }
        },
    )
}

// the adapter's own object path is not exposed; resolve it once from
// the ObjectManager tree by matching the adapter's address (devices[0]
// belongs to a random adapter on multi-adapter setups, and an empty
// device list says nothing)
let adapterObjectPath = "/org/bluez/hci0"
let adapterPathResolved = false

function resolveAdapterPath() {
    if (adapterPathResolved) return
    adapterPathResolved = true
    const wanted = bluetooth.adapter?.address?.toUpperCase()
    if (!wanted) return
    Gio.DBus.system.call(
        "org.bluez",
        "/",
        "org.freedesktop.DBus.ObjectManager",
        "GetManagedObjects",
        null,
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (_conn, res) => {
            try {
                // call_finish returns the reply as ONE tuple variant, not
                // an unpacked array: destructuring it threw TypeError on
                // every call, so this lookup never ran and the adapter
                // path stayed at the /org/bluez/hci0 guess below.
                const objects = Gio.DBus.system.call_finish(res).get_child_value(0)
                const n = objects.n_children()
                for (let i = 0; i < n; i++) {
                    const entry = objects.get_child_value(i)
                    const path = entry.get_child_value(0).get_string()[0]
                    const adapter = entry
                        .get_child_value(1)
                        .lookup_value("org.bluez.Adapter1", null)
                    const addr = adapter?.lookup_value("Address", null)?.get_string()[0]
                    if (addr && addr.toUpperCase() === wanted) {
                        adapterObjectPath = path
                        return
                    }
                }
            } catch (e) {
                console.warn("bluetooth: adapter path lookup failed:", e)
            }
        },
    )
}

function adapterPath(): string {
    return adapterObjectPath
}

// the NotReady retry while the adapter powers on: tracked so the
// pane's cleanup can cancel it
let discoveryRetryId = 0

export function cancelDiscoveryRetry() {
    if (discoveryRetryId) {
        sourceRemove(discoveryRetryId)
        discoveryRetryId = 0
    }
}

resolveAdapterPath()

// discovery start/stop must also be async: the sync versions block the
// main loop (observed 25s) when bluez is busy e.g. pairing
export function startDiscoveryAsync(retried = false): void {
    Gio.DBus.system.call(
        "org.bluez",
        adapterPath(),
        "org.bluez.Adapter1",
        "StartDiscovery",
        null,
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (_conn, res) => {
            try {
                systemCallFinish(res)
            } catch (e) {
                // benign: already discovering (proxy property can be stale)
                if ((e as Error).message?.includes("already in progress")) return
                // the adapter is briefly NotReady while powering on:
                // retry once, or discovery silently never starts
                if (!retried && (e as Error).message?.includes("NotReady")) {
                    discoveryRetryId = timeoutAdd(
                        "btPane:discoveryRetry",
                        GLib.PRIORITY_DEFAULT,
                        500,
                        () => {
                            discoveryRetryId = 0
                            startDiscoveryAsync(true)
                            return GLib.SOURCE_REMOVE
                        },
                    )
                    return
                }
                console.warn("bluetooth start discovery failed:", e)
            }
        },
    )
}

export function stopDiscoveryAsync(): void {
    Gio.DBus.system.call(
        "org.bluez",
        adapterPath(),
        "org.bluez.Adapter1",
        "StopDiscovery",
        null,
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (_conn, res) => {
            try {
                systemCallFinish(res)
            } catch (e) {
                // benign: the discovering proxy property can be stale,
                // and StopDiscovery while the adapter is powering down
                // (toggle off) always fails NotReady — bluez kills
                // discovery on power-down anyway
                const msg = (e as Error).message ?? ""
                if (msg.includes("No discovery started")) return
                if (msg.includes("NotReady")) return
                console.warn("bluetooth stop discovery failed:", e)
            }
        },
    )
}
