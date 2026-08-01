import { DropdownButton } from "./ToggleButton"
import vpnStatus, { connect, disconnect, hasMullvad } from "../../../lib/vpn"

export function VpnButton({ navigate }: { navigate: () => void }) {
    // mullvad CLI required
    if (!hasMullvad) return <></>
    return (
        <DropdownButton
            icon={"network-vpn-symbolic"}
            label={"VPN"}
            // state word while in flux ("Connecting…" is not "Off")
            subtitle={vpnStatus.as(s =>
                s.connected ? s.relay : s.state === "Disconnected" ? "Off" : `${s.state}…`,
            )}
            isActive={vpnStatus.as(s => s.connected)}
            activate={() => {
                // anything but fully disconnected → disconnect: this is
                // also the only way to abort a "Connecting" attempt
                if (vpnStatus.get().state === "Disconnected") connect()
                else disconnect()
            }}
            navigate={navigate}
        />
    )
}
