import { Accessor, Setter, createBinding, createComputed, For } from "gnim";
import { DropdownButton } from "./ToggleButton";
import AstalNetwork from "gi://AstalNetwork?version=0.1";
import { Gtk } from "ags/gtk4";

interface wifiProps {
    activeDropdown: Accessor<number>
    setActiveDropdown: Setter<number>
    dropdownIndex: number
}

interface wifiWidgetProps {
    activeDropdown: Accessor<number>
    dropdownIndex: number
}

export function WifiButton({
    activeDropdown: activeDropdown,
    setActiveDropdown: setActiveDropdown,
    dropdownIndex: dropdownIndex
}: wifiProps) {
    const wifi = AstalNetwork.get_default().wifi

    const label = createComputed(
        [createBinding(wifi, "enabled"), createBinding(wifi, "ssid")],
        (enabled, ssid) => (enabled && ssid) ? ssid : "Wi-Fi"
    )

    return <DropdownButton
        activeDropdown={activeDropdown}
        setActiveDropdown={setActiveDropdown}
        dropdownIndex={dropdownIndex}
        icon={createBinding(wifi, "iconName")}
        label={label}
        isActive={createBinding(wifi, "enabled")}
        activate={() => wifi.set_enabled(!wifi.enabled)}
    />
}

export function WifiWidget({ activeDropdown: revealChild, dropdownIndex: index }: wifiWidgetProps) {
    const wifi = AstalNetwork.get_default().wifi

    const accessPoints = createBinding(wifi, "accessPoints").as(aps =>
        [...aps]
            .sort((a, b) => b.strength - a.strength)
            .slice(0, 8)
    )

    return <revealer
        revealChild={revealChild.as(s => {
            if (s === index) wifi.scan()
            return s === index
        })}
    >
        <box orientation={Gtk.Orientation.VERTICAL}>
            <For each={accessPoints}>
                {(ap) => {
                    const active = createBinding(wifi, "activeAccessPoint")
                        .as(activeAp => activeAp?.bssid === ap.bssid ? ["active"] : [""])
                    return (
                        <box cssName={"button"} cssClasses={active} spacing={5}>
                            <Gtk.GestureClick
                                button={1}
                                onPressed={() => {
                                    // only works for known networks, new
                                    // networks need a password prompt
                                    ap.activate(null).catch((e) => console.error(e))
                                }}
                            />
                            <image iconName={createBinding(ap, "iconName")} />
                            <label label={ap.ssid || "Unknown"} hexpand xalign={0} />
                        </box>
                    )
                }}
            </For>
        </box>
    </revealer>
}
