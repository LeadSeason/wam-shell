import Gtk from "gi://Gtk?version=4.0";
import { createState } from "gnim";
import { SwayGapsButton, SwayGapsWidget } from "./SwayGaps";
import { PowerProfilesButton } from "./powerProfile";
import { WifiButton } from "./wifi";
import { BluetoothButton } from "./bluetooth";
import { WiredButton } from "./wired";
import { NightLightButton, DarkStyleButton, AirplaneModeButton } from "./miscToggles";
import { VpnButton } from "./vpn";

/**
 * @TODO Fix buttons being wonky
 *
 */

export function ToggleSection({ onNavigate }: { onNavigate: (pane: string) => void }) {

    const [activeDropdownIndex, setActiveDropdownIndex] = createState(0);

    return {
        widget: (<box cssClasses={["QSSection"]} orientation={Gtk.Orientation.VERTICAL}>
            <Gtk.FlowBox
                maxChildrenPerLine={2}
                homogeneous
                selectionMode={Gtk.SelectionMode.NONE}
                rowSpacing={8}
                columnSpacing={8}
            >
                <WifiButton navigate={() => onNavigate("wifi")} />
                <BluetoothButton navigate={() => onNavigate("bluetooth")} />
                <WiredButton />
                <PowerProfilesButton navigate={() => onNavigate("powerprofiles")} />
                <SwayGapsButton
                    activeDropdown={activeDropdownIndex}
                    setActiveDropdown={setActiveDropdownIndex}
                    dropdownIndex={1} />
                <NightLightButton />
                <DarkStyleButton />
                <VpnButton />
                <AirplaneModeButton />
            </Gtk.FlowBox>
            <SwayGapsWidget
                activeDropdown={activeDropdownIndex}
                dropdownIndex={1} />

        </box>),
        reset() {
            setActiveDropdownIndex(0)
        }
    }
}
