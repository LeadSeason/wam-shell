import { createBinding, createState, onCleanup, With } from "gnim"
import { DropdownButton } from "./ToggleButton"
import bluetooth, { connectedDevice } from "../../../lib/bluetooth"
import { powerError, powerPending, togglePowered } from "../../../lib/bluetoothCtl"

// the pane (BluetoothWidget, BtSwitch) lives in bluetoothPane.tsx, the
// per-device row in bluetoothDeviceRow.tsx, the async bluez D-Bus calls
// in lib/bluetoothCtl.ts — the pane pieces are re-exported here so
// importers keep a single entry point
export { BluetoothWidget, BtSwitch } from "./bluetoothPane"

export function BluetoothButton({ navigate }: { navigate: () => void }) {
    // the adapter can appear after shell start (rfkill unblock, bluez
    // restart, hotplug) — rebind on it instead of bailing once at
    // construction (same pattern as the wifi/wired toggles)
    return (
        <With value={createBinding(bluetooth, "adapter")}>
            {/* null, not <></>: With appends the child into its own
            Fragment, and nested Fragments are unsupported */}
            {adapter => (adapter ? <BluetoothButtonBody navigate={navigate} /> : null)}
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
    const [active, setActive] = createState(false)

    const update = () => {
        // bluez takes up to a second to power an adapter up or down, and
        // the tile used to keep showing the OLD state for all of it — so
        // the click read as ignored and the obvious response, clicking
        // again, toggled it straight back. Show the target instead; the
        // toggle itself refuses input until bluez has settled
        const target = powerPending.get()
        const powered = target ?? bluetooth.is_powered
        const info = connectedDevice.get()
        setActive(powered)
        setIcon(powered && info ? "bluetooth-active-symbolic" : "bluetooth-symbolic")
        // the device battery rides on the title row as a muted suffix:
        // the subtitle is ellipsized at a bounded width (the FlowBox
        // grid collapses on wide natural sizes), which would eat a
        // trailing "· 100%"
        setBattery(powered && info && info.battery >= 0 ? `${info.battery}%` : "")
        // a refused power change used to be dropped on the floor by
        // astal's fire-and-forget property setter, which is what made
        // the toggle look like it simply did not work sometimes
        const failure = powerError.get()
        if (failure) {
            setSubtitle(failure)
            return
        }
        if (target !== null) {
            setSubtitle(target ? "Turning on…" : "Turning off…")
            return
        }
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
        powerPending.subscribe(update),
        powerError.subscribe(update),
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
            isActive={active}
            activate={togglePowered}
        />
    )
}
