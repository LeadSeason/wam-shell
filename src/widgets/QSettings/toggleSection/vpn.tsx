import { Gtk } from "ags/gtk4"
import { DropdownButton } from "./ToggleButton"
import { isConnected, type VpnBackend } from "../../../lib/vpn"

/**
 * One pill per detected VPN backend.
 *
 * The holder is a FlowBoxChild, not a box: a FlowBox wraps every child
 * in a FlowBoxChild and lays out only visible FLOWBOXCHILDREN, so
 * `visible` on an inner box leaves the wrapper behind as a full blank
 * cell in the homogeneous grid (an inactive backend did exactly that
 * until this was the FlowBoxChild). Binding visible on the FlowBoxChild
 * itself is what actually removes the cell — while still keeping the
 * child inserted, so a backend that appears later (an NM profile
 * created by its vendor app on first connect) fills its original slot
 * instead of being appended to the END of the grid (the bug the
 * NightLightButton note in miscToggles records).
 */
export function VpnButton({ backend, navigate }: { backend: VpnBackend; navigate: () => void }) {
    const { status } = backend
    return (
        <Gtk.FlowBoxChild visible={backend.active}>
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
        </Gtk.FlowBoxChild>
    )
}
