import { Accessor, createBinding, createComputed, For } from "gnim";
import { DropdownButton } from "./ToggleButton";
import AstalNetwork from "gi://AstalNetwork?version=0.1";
import { Gtk } from "ags/gtk4";

interface wifiPaneProps {
    /** current pane name, rescans when this pane becomes visible */
    pane: Accessor<string>
    name: string
}

export function WifiButton({ navigate }: { navigate: () => void }) {
    const wifi = AstalNetwork.get_default().wifi

    const subtitle = createComputed(
        [createBinding(wifi, "enabled"), createBinding(wifi, "ssid")],
        (enabled, ssid) => enabled ? (ssid || "On") : "Off"
    )

    return <DropdownButton
        navigate={navigate}
        icon={createBinding(wifi, "iconName")}
        label={"Wi-Fi"}
        subtitle={subtitle}
        isActive={createBinding(wifi, "enabled")}
        activate={() => wifi.set_enabled(!wifi.enabled)}
    />
}

export function WifiWidget({ pane, name }: wifiPaneProps) {
    const wifi = AstalNetwork.get_default().wifi

    // rescan whenever this pane becomes visible
    pane.subscribe(v => {
        if (v === name) wifi.scan()
    })

    const accessPoints = createBinding(wifi, "accessPoints").as(aps =>
        [...aps]
            .sort((a, b) => b.strength - a.strength)
            .slice(0, 8)
    )

    return <box orientation={Gtk.Orientation.VERTICAL}>
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
}
