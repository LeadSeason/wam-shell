import { execAsync } from "../../../lib/metrics"
import { DropdownButton } from "./ToggleButton"
import vpnStatus, { hasMullvad, refreshVpn } from "../../../lib/vpn"

export function VpnButton({ navigate }: { navigate: () => void }) {
    // mullvad CLI required
    if (!hasMullvad) return <></>
    return (
        <DropdownButton
            icon={"network-vpn-symbolic"}
            label={"VPN"}
            subtitle={vpnStatus.as(s => (s.connected ? s.relay : "Off"))}
            isActive={vpnStatus.as(s => s.connected)}
            activate={() => {
                execAsync(["mullvad", vpnStatus.get().connected ? "disconnect" : "connect"])
                    .then(() => refreshVpn())
                    .catch(e => console.warn(e))
            }}
            navigate={navigate}
        />
    )
}
