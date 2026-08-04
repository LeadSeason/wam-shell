import { createBinding, createComputed, With } from "gnim"
import { DropdownButton } from "./ToggleButton"
import bluetooth, { batteryPercent } from "../../../lib/bluetooth"

// the pane (BluetoothWidget, BtSwitch) lives in bluetoothPane.tsx, the
// per-device row in bluetoothDeviceRow.tsx, the async bluez D-Bus calls
// in bluez.ts — re-exported here so importers keep a single entry point
export { BluetoothWidget, BtSwitch } from "./bluetoothPane"

export function BluetoothButton({ navigate }: { navigate: () => void }) {
    // the adapter can appear after shell start (rfkill unblock, bluez
    // restart, hotplug) — rebind on it instead of bailing once at
    // construction (same pattern as the wifi/wired toggles)
    return (
        <With value={createBinding(bluetooth, "adapter")}>
            {adapter => (adapter ? <BluetoothButtonBody navigate={navigate} /> : <></>)}
        </With>
    )
}

function BluetoothButtonBody({ navigate }: { navigate: () => void }) {
    // battery only re-evaluates when the device list or power changes;
    // good enough for a subtitle
    const subtitle = createComputed(
        [createBinding(bluetooth, "is_powered"), createBinding(bluetooth, "devices")],
        (powered, devices) => {
            if (!powered) return "Off"
            const connected = devices.find(d => d.connected)
            if (!connected) return "On"
            const name = connected.alias || connected.name
            const battery = batteryPercent(connected)
            return battery >= 0 ? `${name} · ${battery}%` : name
        },
    )

    const icon = createBinding(bluetooth, "is_connected").as(connected =>
        connected ? "bluetooth-active-symbolic" : "bluetooth-symbolic",
    )

    return (
        <DropdownButton
            navigate={navigate}
            icon={icon}
            label={"Bluetooth"}
            subtitle={subtitle}
            isActive={createBinding(bluetooth, "is_powered")}
            activate={() => {
                const adapter = bluetooth.adapter
                if (adapter) adapter.powered = !adapter.powered
            }}
        />
    )
}
