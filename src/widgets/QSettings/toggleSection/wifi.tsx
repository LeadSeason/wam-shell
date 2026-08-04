import { createBinding, createComputed, With } from "gnim"
import { DropdownButton, bandBadgeOf } from "./ToggleButton"
import AstalNetwork from "gi://AstalNetwork?version=0.1"

// the pane (WifiWidget, WifiSwitch) lives in wifiPane.tsx, the per-AP
// row and password prompt in wifiApRow.tsx, the saved-networks NM
// client in savedNetworks.ts — re-exported here so importers keep a
// single entry point
export { WifiWidget, WifiSwitch } from "./wifiPane"

export function WifiButton({ navigate }: { navigate: () => void }) {
    // Network.wifi goes null when the adapter is removed (USB wifi):
    // rebind so the toggle drops out of the grid instead of freezing
    // at its last state
    return (
        <With value={createBinding(AstalNetwork.get_default(), "wifi")}>
            {wifi => wifi && <WifiToggleButton wifi={wifi} navigate={navigate} />}
        </With>
    )
}

function WifiToggleButton({ wifi, navigate }: { wifi: AstalNetwork.Wifi; navigate: () => void }) {
    const subtitle = createComputed(
        [createBinding(wifi, "enabled"), createBinding(wifi, "ssid")],
        (enabled, ssid) => (enabled ? ssid || "On" : "Off"),
    )
    // band badge on the tile icon, only while associated
    const badge = createComputed(
        [createBinding(wifi, "enabled"), createBinding(wifi, "activeAccessPoint")],
        (enabled, ap) => (enabled && ap ? bandBadgeOf(ap.frequency) : ""),
    )

    return (
        <DropdownButton
            navigate={navigate}
            icon={createBinding(wifi, "iconName")}
            badge={badge}
            label={"Wi-Fi"}
            subtitle={subtitle}
            isActive={createBinding(wifi, "enabled")}
            activate={() => wifi.set_enabled(!wifi.enabled)}
        />
    )
}
