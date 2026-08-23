import { createBinding, createState, onCleanup, With } from "gnim"
import { DropdownButton } from "./ToggleButton"
import bluetooth, { connectedDevice } from "../../../lib/bluetooth"

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
    // derived imperatively, not via array-form createComputed: its dep
    // cache keys on falsy checks and connectedDevice starts null, which
    // can leave the computed stale (see AGENTS.md)
    const [subtitle, setSubtitle] = createState("Off")
    const [battery, setBattery] = createState("")
    const [icon, setIcon] = createState("bluetooth-symbolic")

    const update = () => {
        const powered = bluetooth.is_powered
        const info = connectedDevice.get()
        setIcon(powered && info ? "bluetooth-active-symbolic" : "bluetooth-symbolic")
        // the device battery rides on the title row as a muted suffix:
        // the subtitle is ellipsized at a bounded width (the FlowBox
        // grid collapses on wide natural sizes), which would eat a
        // trailing "· 100%"
        setBattery(powered && info && info.battery >= 0 ? `${info.battery}%` : "")
        if (!powered) {
            setSubtitle("Off")
            return
        }
        if (!info) {
            setSubtitle("On")
            return
        }
        setSubtitle(info.device.alias || info.device.name)
    }
    const disposers = [
        createBinding(bluetooth, "is_powered").subscribe(update),
        connectedDevice.subscribe(update),
    ]
    // this body remounts whenever the adapter flips (see BluetoothButton)
    onCleanup(() => disposers.forEach(d => d()))
    update()

    return (
        <DropdownButton
            navigate={navigate}
            icon={icon}
            label={"Bluetooth"}
            titleSuffix={battery}
            subtitle={subtitle}
            isActive={createBinding(bluetooth, "is_powered")}
            activate={() => {
                const adapter = bluetooth.adapter
                if (adapter) adapter.powered = !adapter.powered
            }}
        />
    )
}
