import { Accessor, Setter, createBinding, createComputed, For } from "gnim";
import { DropdownButton } from "./ToggleButton";
import AstalBluetooth from "gi://AstalBluetooth?version=0.1";
import { Gtk } from "ags/gtk4";

interface bluetoothProps {
    activeDropdown: Accessor<number>
    setActiveDropdown: Setter<number>
    dropdownIndex: number
}

interface bluetoothWidgetProps {
    activeDropdown: Accessor<number>
    dropdownIndex: number
}

export function BluetoothButton({
    activeDropdown: activeDropdown,
    setActiveDropdown: setActiveDropdown,
    dropdownIndex: dropdownIndex
}: bluetoothProps) {
    const bluetooth = AstalBluetooth.get_default()

    const label = createComputed(
        [createBinding(bluetooth, "is_powered"), createBinding(bluetooth, "devices")],
        (powered, devices) => {
            if (!powered) return "Bluetooth"
            const connected = devices.find(d => d.connected)
            return connected ? (connected.alias || connected.name) : "Bluetooth"
        }
    )

    const icon = createBinding(bluetooth, "is_connected")
        .as(connected => connected ? "bluetooth-active-symbolic" : "bluetooth-symbolic")

    return <DropdownButton
        activeDropdown={activeDropdown}
        setActiveDropdown={setActiveDropdown}
        dropdownIndex={dropdownIndex}
        icon={icon}
        label={label}
        isActive={createBinding(bluetooth, "is_powered")}
        activate={() => {
            const adapter = bluetooth.adapter
            if (adapter) adapter.powered = !adapter.powered
        }}
    />
}

export function BluetoothWidget({ activeDropdown: revealChild, dropdownIndex: index }: bluetoothWidgetProps) {
    const bluetooth = AstalBluetooth.get_default()
    const devices = createBinding(bluetooth, "devices").as(devices =>
        devices.filter(d => d.paired || d.connected)
    )

    return <revealer
        revealChild={revealChild.as(s => (s === index))}
    >
        <box orientation={Gtk.Orientation.VERTICAL}>
            <For each={devices}>
                {(device) => (
                    <box
                        cssName={"button"}
                        cssClasses={createBinding(device, "connected").as(c => c ? ["active"] : [""])}
                        spacing={5}
                    >
                        <Gtk.GestureClick
                            button={1}
                            onPressed={() => {
                                const action = device.connected
                                    ? device.disconnect_device()
                                    : device.connect_device()
                                Promise.resolve(action).catch((e) => console.error(e))
                            }}
                        />
                        <image iconName={device.icon || "bluetooth-symbolic"} />
                        <label label={device.alias || device.name} hexpand xalign={0} />
                    </box>
                )}
            </For>
        </box>
    </revealer>
}
