import { Accessor, createBinding, createComputed, For } from "gnim";
import { DropdownButton } from "./ToggleButton";
import AstalBluetooth from "gi://AstalBluetooth?version=0.1";
import { Gtk } from "ags/gtk4";

export function BluetoothButton({ navigate }: { navigate: () => void }) {
    const bluetooth = AstalBluetooth.get_default()

    const subtitle = createComputed(
        [createBinding(bluetooth, "is_powered"), createBinding(bluetooth, "devices")],
        (powered, devices) => {
            if (!powered) return "Off"
            const connected = devices.find(d => d.connected)
            return connected ? (connected.alias || connected.name) : "On"
        }
    )

    const icon = createBinding(bluetooth, "is_connected")
        .as(connected => connected ? "bluetooth-active-symbolic" : "bluetooth-symbolic")

    return <DropdownButton
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
}

export function BluetoothWidget() {
    const bluetooth = AstalBluetooth.get_default()
    const devices = createBinding(bluetooth, "devices").as(devices =>
        devices.filter(d => d.paired || d.connected)
    )

    return <box orientation={Gtk.Orientation.VERTICAL}>
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
}
