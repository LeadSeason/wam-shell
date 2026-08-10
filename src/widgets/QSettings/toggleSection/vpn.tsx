import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import { createComputed, createState, onCleanup } from "gnim"
import { timeoutAdd, sourceRemove } from "../../../lib/metrics"
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
    const pending = status.as(s => s.state === "connecting" || s.state === "disconnecting")
    // pending flashes the icon (normal ↔ dim, 600ms): a JS-driven flip,
    // because CSS opacity animations don't run in this shell (the sleep
    // timer's alarmAttention in QSettingsLabel is the reference)
    const [flashOn, setFlashOn] = createState(true)
    let flashSource = 0
    const unsub = pending.subscribe(() => {
        if (pending.get()) {
            if (flashSource === 0) {
                setFlashOn(true)
                flashSource = timeoutAdd("qsettings:vpnFlash", GLib.PRIORITY_DEFAULT, 600, () => {
                    setFlashOn(!flashOn.get())
                    return true
                })
            }
        } else if (flashSource !== 0) {
            sourceRemove(flashSource)
            flashSource = 0
        }
    })
    onCleanup(() => {
        unsub()
        if (flashSource !== 0) {
            sourceRemove(flashSource)
            flashSource = 0
        }
    })
    // visually down: really down, or the off beat of the pending flash
    const down = createComputed([status, flashOn], (s, f) => {
        if (isConnected(s)) return false
        if (s.state === "connecting" || s.state === "disconnecting") return !f
        return true
    })
    return (
        <Gtk.FlowBoxChild visible={backend.active}>
            <DropdownButton
                // a backend with a dedicated down glyph (Mullvad's open
                // shackle) swaps to it; the rest just dim
                icon={down.as(d =>
                    d && backend.iconNameDown ? backend.iconNameDown : backend.iconName,
                )}
                // the brand glyph carries the state: down dims, pending
                // flashes (a "blocked"/Failed tunnel is not up, so it
                // reads as down), up needs nothing — the active pill
                // accent already says it
                iconClasses={createComputed([status, down], (s, d) => [
                    "vpnIcon",
                    isConnected(s)
                        ? "up"
                        : s.state === "connecting" || s.state === "disconnecting"
                          ? d
                              ? "down"
                              : "pending"
                          : "down",
                ])}
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
                    // is also the only way to abort a "Connecting"
                    // attempt. While DISCONNECTING a click is ignored —
                    // aborting a teardown is meaningless, and the click
                    // would otherwise queue a connect into it
                    const s = status.get().state
                    if (s === "disconnected") backend.connect()
                    else if (s !== "disconnecting") backend.disconnect()
                }}
                navigate={navigate}
            />
        </Gtk.FlowBoxChild>
    )
}
