import Gio from "gi://Gio?version=2.0"
import GLib from "gi://GLib?version=2.0"
import AstalBluetooth from "gi://AstalBluetooth?version=0.1"
import Config from "../config"

// Shared bluetooth state + connect/battery event notifications.

const bluetooth = AstalBluetooth.get_default()

const LOW_BATTERY = 20

// per-device watcher state, keyed by address
interface WatchState {
    connected: boolean
    batteryWarned: boolean
}
const watched = new Map<string, WatchState>()

/** send a notification through the daemon (we ARE the daemon; calling
 *  our own bus name loops through the bus like any other client) */
function notify(summary: string, body: string, icon: string, urgency: number) {
    Gio.DBus.session.call(
        "org.freedesktop.Notifications",
        "/org/freedesktop/Notifications",
        "org.freedesktop.Notifications",
        "Notify",
        new GLib.Variant("(susssasa{sv}i)", [
            "wam-shell", 0, icon, summary, body, [],
            // a{sv} inside a tuple must be a plain object of variants
            // for gjs to pack it
            { urgency: new GLib.Variant("y", urgency) }, -1,
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
    if (watched.has(address)) return
    // seed current state: only changes after startup notify
    watched.set(address, { connected: device.connected, batteryWarned: false })

    device.connect("notify::connected", () => {
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
        )
    })

    device.connect("notify::battery-percentage", () => {
        if (!Config.bluetooth.notifications) return
        const state = watched.get(address)
        const battery = device.batteryPercentage
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
    })
}

// the adapter can appear after shell start (rfkill unblock, bluez
// restart, hotplug) — watch devices whenever one shows up
function watchAllDevices() {
    for (const device of bluetooth.devices) watchDevice(device)
}

bluetooth.connect("notify::devices", watchAllDevices)
bluetooth.connect("notify::adapter", () => {
    if (bluetooth.adapter) watchAllDevices()
})
if (bluetooth.adapter) watchAllDevices()

export default bluetooth
