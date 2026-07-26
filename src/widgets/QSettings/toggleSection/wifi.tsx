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
    // (subscribe callbacks receive no value, read it)
    pane.subscribe(() => {
        if (pane.get() === name) wifi.scan()
    })

    const accessPoints = createBinding(wifi, "accessPoints").as(aps =>
        [...aps]
            .filter(ap => ap.ssid) // skip hidden networks
            .sort((a, b) => b.strength - a.strength)
            .slice(0, 8)
    )

    // the same SSID is often broadcast on multiple bands, group by band
    const band = (ap: AstalNetwork.AccessPoint): string => {
        if (ap.frequency >= 5925) return "6GHz"
        if (ap.frequency >= 5000) return "5GHz"
        return "2.4GHz"
    }

    const groups = accessPoints.as(aps => {
        const byBand = new Map<string, AstalNetwork.AccessPoint[]>()
        for (const ap of aps) {
            const b = band(ap)
            if (!byBand.has(b)) byBand.set(b, [])
            byBand.get(b)!.push(ap)
        }
        return ["6GHz", "5GHz", "2.4GHz"]
            .filter(b => byBand.has(b))
            .map(b => ({ band: b, aps: byBand.get(b)! }))
    })

    function ApRow({ ap }: { ap: AstalNetwork.AccessPoint }) {
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
                <label label={ap.ssid} hexpand xalign={0} />
            </box>
        )
    }

    return <box orientation={Gtk.Orientation.VERTICAL}>
        <For each={groups}>
            {(g) => (
                <box orientation={Gtk.Orientation.VERTICAL}>
                    <label
                        label={g.band}
                        cssClasses={["wifiBand"]}
                        xalign={0}
                    />
                    {g.aps.map(ap => <ApRow ap={ap} />)}
                </box>
            )}
        </For>
    </box>
}
