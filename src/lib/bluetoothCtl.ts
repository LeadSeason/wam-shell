import AstalBluetooth from "gi://AstalBluetooth?version=0.1"
import Gio from "gi://Gio?version=2.0"
import GLib from "gi://GLib?version=2.0"
import { createState } from "gnim"
import bluetooth from "./bluetooth"
import { bluezErrorText } from "./bluezErrors"
import { timeoutAdd, sourceRemove, connect, disconnect } from "./metrics"
import { registerDispose } from "./lifecycle"

// Every bluez call the shell makes, issued ASYNC.
//
// AstalBluetooth's own methods are the wrong tool twice over:
//
//  - `pair()` and `Adapter.remove_device()` are SYNC D-Bus calls. They
//    block the whole main loop, which froze the shell and queued agent
//    prompts behind the block.
//  - the ones that ARE async (`connect_device`, and every property
//    setter) go through the proxy with a -1 timeout, which is GDBus's
//    DEFAULT of 25 seconds — shorter than a pairing where a human has
//    to read a passkey, and shorter than a Connect to a device that is
//    asleep. Vala's generated property setters are worse still:
//    `g_dbus_proxy_call(..., NULL, NULL, NULL)`, fire-and-forget with
//    the error argument literally dropped, so a rejected `powered = false`
//    was indistinguishable from one that worked.
//
// So the timeouts here are explicit and generous, and every call reports
// what bluez actually said.

/** bluez's own agent request timeout is 60s, so a Pair always settles
 *  well inside this; the GDBus default of 25s did not, and cut off
 *  pairings the user was still confirming */
const PAIR_TIMEOUT_MS = 90_000
/** a Connect to a device that has to be woken (headphones in a case,
 *  a speaker on standby) routinely runs past 25s */
const CONNECT_TIMEOUT_MS = 60_000
/** everything else: bookkeeping calls bluez answers immediately, where a
 *  wait this long already means it is not going to */
const CALL_TIMEOUT_MS = 20_000

function devicePath(device: AstalBluetooth.Device): string {
    return `${device.adapter}/dev_${device.address.replaceAll(":", "_")}`
}

/** one async bluez call as a promise, with an explicit timeout */
function call(
    path: string,
    iface: string,
    method: string,
    params: GLib.Variant | null,
    timeout: number,
): Promise<void> {
    return new Promise((resolve, reject) => {
        Gio.DBus.system.call(
            "org.bluez",
            path,
            iface,
            method,
            params,
            null,
            Gio.DBusCallFlags.NONE,
            timeout,
            null,
            (_conn, res) => {
                try {
                    Gio.DBus.system.call_finish(res)
                    resolve()
                } catch (e) {
                    reject(e)
                }
            },
        )
    })
}

export function pairDeviceAsync(device: AstalBluetooth.Device): Promise<void> {
    return call(devicePath(device), "org.bluez.Device1", "Pair", null, PAIR_TIMEOUT_MS)
}

/** tell bluez to abandon a pairing we gave up on. Rejecting the agent
 *  prompt alone leaves bluez still trying, and the half-built device it
 *  leaves behind is what makes every RETRY fail too */
export function cancelPairingAsync(device: AstalBluetooth.Device): Promise<void> {
    return call(devicePath(device), "org.bluez.Device1", "CancelPairing", null, CALL_TIMEOUT_MS)
}

export function connectDeviceAsync(device: AstalBluetooth.Device): Promise<void> {
    return call(devicePath(device), "org.bluez.Device1", "Connect", null, CONNECT_TIMEOUT_MS)
}

export function disconnectDeviceAsync(device: AstalBluetooth.Device): Promise<void> {
    return call(devicePath(device), "org.bluez.Device1", "Disconnect", null, CONNECT_TIMEOUT_MS)
}

export function removeDeviceAsync(device: AstalBluetooth.Device): Promise<void> {
    return call(
        `${device.adapter}`,
        "org.bluez.Adapter1",
        "RemoveDevice",
        new GLib.Variant("(o)", [devicePath(device)]),
        CALL_TIMEOUT_MS,
    )
}

// the adapter's own object path is not exposed; resolve it from the
// ObjectManager tree by matching the adapter's address (devices[0]
// belongs to a random adapter on multi-adapter setups, and an empty
// device list says nothing)
let adapterObjectPath = "/org/bluez/hci0"
let adapterPathResolved = false

function resolveAdapterPath() {
    if (adapterPathResolved) return
    const wanted = bluetooth.adapter?.address?.toUpperCase()
    // no adapter yet (rfkill'd, bluez down at import): leave the flag
    // unset so the next call retries the lookup instead of staying
    // pinned to the /org/bluez/hci0 guess
    if (!wanted) return
    Gio.DBus.system.call(
        "org.bluez",
        "/",
        "org.freedesktop.DBus.ObjectManager",
        "GetManagedObjects",
        null,
        null,
        Gio.DBusCallFlags.NONE,
        CALL_TIMEOUT_MS,
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
                        adapterPathResolved = true
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

// ---------------------------------------------------------------- power

// Powering an adapter up or down is not instant — bluez reports it as a
// PowerState of "off-enabling" / "on-disabling" and only then flips
// Powered — and astal's `adapter.powered = x` neither reports failures
// nor updates its own cached value until bluez confirms. Both together
// made the toggle look broken: the tile stayed lit for the length of the
// transition, so the click read as ignored, and a second click on a tile
// that had not visibly moved toggled it straight back. A rejected write
// (rfkill, a transition already running) looked exactly the same.
//
// So the target is tracked here: the UI shows it immediately, further
// clicks are ignored until bluez agrees or the attempt gives up, and a
// failure gets said out loud instead of dropped.

/** the state being switched TO while a power change is in flight, else
 *  null. The tile and the pane switch both render this optimistically */
const [powerPending, setPowerPending] = createState<boolean | null>(null)
/** last power failure, user-facing and self-clearing */
const [powerError, setPowerError] = createState("")
export { powerPending, powerError }

// bluez confirms a power change in well under a second on every adapter
// measured; this is only here so a bluez that never answers cannot wedge
// the toggle for the rest of the session
const POWER_SETTLE_MS = 10_000
const POWER_ERROR_MS = 4000

let settleTimer = 0
let settleWatch = 0
let errorTimer = 0

function endPending() {
    if (settleTimer) {
        sourceRemove(settleTimer)
        settleTimer = 0
    }
    if (settleWatch) {
        disconnect(bluetooth, settleWatch)
        settleWatch = 0
    }
    setPowerPending(null)
}

function failPower(text: string) {
    endPending()
    setPowerError(text)
    if (errorTimer) sourceRemove(errorTimer)
    errorTimer = timeoutAdd("btCtl:powerError", GLib.PRIORITY_DEFAULT, POWER_ERROR_MS, () => {
        errorTimer = 0
        setPowerError("")
        return GLib.SOURCE_REMOVE
    })
}

/**
 * Switch the adapter on or off, and hold the target until bluez agrees.
 *
 * A no-op while a change is already in flight: that is the debounce that
 * stops an impatient second click from undoing the first.
 */
export function setPoweredAsync(target: boolean): void {
    if (powerPending.get() !== null) return
    if (!bluetooth.adapter) return
    resolveAdapterPath()
    setPowerError("")
    setPowerPending(target)

    const summary = target ? "Could not turn on" : "Could not turn off"
    const settled = () => {
        if (bluetooth.is_powered === target) endPending()
    }

    // clear as soon as bluez reports the adapter actually REACHED the
    // target, rather than when the call returns — the Set reply lands
    // while PowerState is still "off-enabling"
    settleWatch = connect(bluetooth, "notify::is-powered", settled)
    settleTimer = timeoutAdd("btCtl:powerSettle", GLib.PRIORITY_DEFAULT, POWER_SETTLE_MS, () => {
        settleTimer = 0
        if (bluetooth.is_powered === target) endPending()
        else failPower(summary)
        return GLib.SOURCE_REMOVE
    })

    call(
        adapterPath(),
        "org.freedesktop.DBus.Properties",
        "Set",
        new GLib.Variant("(ssv)", ["org.bluez.Adapter1", "Powered", new GLib.Variant("b", target)]),
        CALL_TIMEOUT_MS,
    )
        // the settle watch owns the rest: bluez has accepted the change
        // but not finished making it
        .then(settled)
        .catch(e => {
            console.warn("bluetooth: power change failed:", e)
            failPower(bluezErrorText(e, summary))
        })
}

/** flip the adapter, from the state the UI is actually showing */
export function togglePowered(): void {
    setPoweredAsync(!bluetooth.is_powered)
}

// ------------------------------------------------------------ discovery

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

export function startDiscoveryAsync(retried = false): void {
    // retry the adapter path lookup until it succeeds: the adapter can
    // be absent at import time (rfkill, bluez restart) and appear later
    resolveAdapterPath()
    call(adapterPath(), "org.bluez.Adapter1", "StartDiscovery", null, CALL_TIMEOUT_MS).catch(e => {
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
    })
}

export function stopDiscoveryAsync(): void {
    call(adapterPath(), "org.bluez.Adapter1", "StopDiscovery", null, CALL_TIMEOUT_MS).catch(e => {
        // benign: the discovering proxy property can be stale, and
        // StopDiscovery while the adapter is powering down (toggle off)
        // always fails NotReady — bluez kills discovery on power-down
        // anyway
        const msg = (e as Error).message ?? ""
        if (msg.includes("No discovery started")) return
        if (msg.includes("NotReady")) return
        console.warn("bluetooth stop discovery failed:", e)
    })
}

// convention for lib modules with long-lived sources (see AGENTS.md)
export function dispose() {
    cancelDiscoveryRetry()
    endPending()
    if (errorTimer) {
        sourceRemove(errorTimer)
        errorTimer = 0
    }
    setPowerError("")
}

// tear-down entry point, run from app.tsx on shutdown (lib/lifecycle)
registerDispose("bluetoothCtl", dispose)
