import Gio from "gi://Gio?version=2.0"
import GLib from "gi://GLib?version=2.0"
import AstalBluetooth from "gi://AstalBluetooth?version=0.1"
import Config from "../config"
import { connect, disconnect } from "./metrics"
import { batteryPercentValue } from "./utils"

// Shared bluetooth state + connect/battery event notifications.

const bluetooth = AstalBluetooth.get_default()

const LOW_BATTERY = 20 // percent

export function batteryPercent(device: AstalBluetooth.Device): number {
    return batteryPercentValue(device.batteryPercentage)
}

// per-device watcher state, keyed by address
interface WatchState {
    connected: boolean
    batteryWarned: boolean
    device: AstalBluetooth.Device
    handlerIds: number[]
}
const watched = new Map<string, WatchState>()

/** send a notification through the daemon (we ARE the daemon; calling
 *  our own bus name loops through the bus like any other client).
 *  transient marks it attention-only: shown as a popup, excluded from
 *  the center's history (the spec `transient` hint) */
function notify(summary: string, body: string, icon: string, urgency: number, transient = false) {
    const hints: Record<string, GLib.Variant> = { urgency: new GLib.Variant("y", urgency) }
    if (transient) hints.transient = new GLib.Variant("b", true)
    Gio.DBus.session.call(
        "org.freedesktop.Notifications",
        "/org/freedesktop/Notifications",
        "org.freedesktop.Notifications",
        "Notify",
        new GLib.Variant("(susssasa{sv}i)", [
            "wam-shell",
            0,
            icon,
            summary,
            body,
            [],
            // a{sv} inside a tuple must be a plain object of variants
            // for gjs to pack it
            hints,
            -1,
        ]),
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (_conn, res) => {
            try {
                Gio.DBus.session.call_finish(res)
            } catch (e) {
                console.warn("bluetooth notify failed:", e)
            }
        },
    )
}

function watchDevice(device: AstalBluetooth.Device) {
    const address = device.address
    if (watched.get(address)?.device === device) return
    // bluez can recreate the device object: drop the stale handlers
    unwatchDevice(address)
    const handlerIds: number[] = []
    // seed current state: only changes after startup notify
    watched.set(address, {
        connected: device.connected,
        batteryWarned: false,
        device,
        handlerIds,
    })

    handlerIds.push(
        connect(device, "notify::connected", () => {
            if (!Config.bluetooth.notifications) return
            const state = watched.get(address)
            if (!state || state.connected === device.connected) return
            state.connected = device.connected
            state.batteryWarned = false
            const name = device.alias || device.name || address
            notify(
                name,
                device.connected ? "Connected" : "Disconnected",
                device.icon || "bluetooth-symbolic",
                0, // low urgency
                true, // attention-only: no history in the center
            )
        }),
    )

    handlerIds.push(
        connect(device, "notify::battery-percentage", () => {
            if (!Config.bluetooth.notifications) return
            const state = watched.get(address)
            const battery = batteryPercent(device)
            if (!state || !device.connected || battery < 0) return
            if (battery <= LOW_BATTERY && !state.batteryWarned) {
                state.batteryWarned = true
                const name = device.alias || device.name || address
                notify(
                    name,
                    `Battery low (${battery}%)`,
                    device.icon || "bluetooth-symbolic",
                    1, // normal urgency
                )
            } else if (battery > LOW_BATTERY) {
                state.batteryWarned = false
            }
        }),
    )
}

function unwatchDevice(address: string) {
    const state = watched.get(address)
    if (!state) return
    for (const id of state.handlerIds) disconnect(state.device, id)
    watched.delete(address)
}

// the adapter can appear after shell start (rfkill unblock, bluez
// restart, hotplug) — watch devices whenever one shows up
function watchAllDevices() {
    const live = new Set(bluetooth.devices.map(d => d.address))
    for (const address of [...watched.keys()]) {
        if (!live.has(address)) unwatchDevice(address)
    }
    for (const device of bluetooth.devices) watchDevice(device)
}

connect(bluetooth, "notify::devices", watchAllDevices)
connect(bluetooth, "notify::adapter", () => {
    if (bluetooth.adapter) watchAllDevices()
})
if (bluetooth.adapter) watchAllDevices()

export default bluetooth
