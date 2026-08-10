import { DropdownButton } from "./ToggleButton"
import { isConnected, type VpnBackend } from "../../../lib/vpn"

/**
 * One pill per detected VPN backend.
 *
 * Wrapped in a holder box with a bound `visible`, not returned bare —
 * see the note on NightLightButton in miscToggles: the toggle FlowBox is
 * homogeneous, so an empty-but-visible holder would reserve a blank
 * cell, while a backend that appears later (an NM profile created by its
 * vendor app on first connect) must be able to fill this slot without
 * being appended to the END of the grid.
 */
export function VpnButton({ backend, navigate }: { backend: VpnBackend; navigate: () => void }) {
    const { status } = backend
    return (
        <box visible={backend.active}>
            <DropdownButton
                icon={backend.iconName}
                label={backend.name}
                // state word while in flux ("Connecting…" is not "Off")
                subtitle={status.as(s =>
                    isConnected(s)
                        ? s.server
                        : s.state === "disconnected"
                          ? "Off"
                          : `${s.stateLabel}…`,
                )}
                isActive={status.as(s => isConnected(s))}
                activate={() => {
                    // anything but fully disconnected → disconnect: this
                    // is also the only way to abort a "Connecting" attempt
                    if (status.get().state === "disconnected") backend.connect()
                    else backend.disconnect()
                }}
                navigate={navigate}
            />
        </box>
    )
}
