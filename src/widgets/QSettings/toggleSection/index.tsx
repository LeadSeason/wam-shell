import Gtk from "gi://Gtk?version=4.0"
import { createState } from "gnim"
import { SwayGapsButton, SwayGapsWidget } from "./SwayGaps"
import { PowerProfilesButton } from "./powerProfile"
import { WifiButton } from "./wifi"
import { BluetoothButton } from "./bluetooth"
import { WiredButton } from "./wired"
import { NightLightButton, DarkStyleButton, KeepAwakeButton } from "./miscToggles"
import { SleepTimerButton, SleepTimerWidget } from "./sleepTimer"
import { VpnButton } from "./vpn"
import { backends as vpnBackends, vpnPaneName } from "../../../lib/vpn"

/**
 * @TODO Fix buttons being wonky
 *
 */

export function ToggleSection({ onNavigate }: { onNavigate: (pane: string) => void }) {
    const [activeDropdownIndex, setActiveDropdownIndex] = createState(0)

    return {
        widget: (
            <box cssClasses={["QSSection"]} orientation={Gtk.Orientation.VERTICAL}>
                <Gtk.FlowBox
                    maxChildrenPerLine={2}
                    homogeneous
                    selectionMode={Gtk.SelectionMode.NONE}
                    rowSpacing={8}
                    columnSpacing={8}
                >
                    <WifiButton navigate={() => onNavigate("wifi")} />
                    <BluetoothButton navigate={() => onNavigate("bluetooth")} />
                    <WiredButton navigate={() => onNavigate("wired")} />
                    <PowerProfilesButton navigate={() => onNavigate("powerprofiles")} />
                    <SwayGapsButton
                        activeDropdown={activeDropdownIndex}
                        setActiveDropdown={setActiveDropdownIndex}
                        dropdownIndex={1}
                    />
                    <NightLightButton />
                    <DarkStyleButton />
                    {/* one pill per registered VPN backend, each hiding
                    itself when undetected. A synchronous map, not a
                    <For>: these are inserted during the initial build
                    pass and so keep their place in the grid, where a
                    child appended LATER goes to the end of the FlowBox
                    (the bug the NightLightButton note in miscToggles
                    records). Backends are all registered by now — the
                    lib/vpn barrel imports them */}
                    {vpnBackends.map(b => (
                        <VpnButton backend={b} navigate={() => onNavigate(vpnPaneName(b.id))} />
                    ))}
                    <SleepTimerButton
                        activeDropdown={activeDropdownIndex}
                        setActiveDropdown={setActiveDropdownIndex}
                        dropdownIndex={2}
                    />
                    {/* next to the sleep timer on purpose: they are the
                    same axis pointed opposite ways — one puts the
                    machine down early, the other refuses to let it go */}
                    <KeepAwakeButton />
                </Gtk.FlowBox>
                <SwayGapsWidget activeDropdown={activeDropdownIndex} dropdownIndex={1} />
                <SleepTimerWidget activeDropdown={activeDropdownIndex} dropdownIndex={2} />
            </box>
        ),
        reset() {
            setActiveDropdownIndex(0)
        },
    }
}
