import Gtk from "gi://Gtk?version=4.0";
import { Accessor, createState } from "gnim";
import { SwayGapsButton, SwayGapsWidget } from "./SwayGaps";
import { PowerProfilesButton, PowerProfilesWidget } from "./powerProfile";
import { WifiButton, WifiWidget } from "./wifi";
import { BluetoothButton, BluetoothWidget } from "./bluetooth";
import { NightLightButton, DarkStyleButton, AirplaneModeButton } from "./miscToggles";

/**
 * @TODO Fix buttons being wonky
 *
 */

export function ToggleSection() {

    const [activeDropdownIndex, setActiveDropdownIndex] = createState(0);

    return {
        widget: (<box cssClasses={["QSSection"]} orientation={Gtk.Orientation.VERTICAL}>
            <Gtk.FlowBox
                maxChildrenPerLine={2}
                homogeneous
                selectionMode={Gtk.SelectionMode.NONE}
            >
                <WifiButton
                    activeDropdown={activeDropdownIndex}
                    setActiveDropdown={setActiveDropdownIndex}
                    dropdownIndex={3} />
                <BluetoothButton
                    activeDropdown={activeDropdownIndex}
                    setActiveDropdown={setActiveDropdownIndex}
                    dropdownIndex={4} />
                <PowerProfilesButton
                    activeDropdown={activeDropdownIndex}
                    setActiveDropdown={setActiveDropdownIndex}
                    dropdownIndex={2} />
                <SwayGapsButton
                    activeDropdown={activeDropdownIndex}
                    setActiveDropdown={setActiveDropdownIndex}
                    dropdownIndex={1} />
                <NightLightButton
                    activeDropdown={activeDropdownIndex}
                    setActiveDropdown={setActiveDropdownIndex}
                    dropdownIndex={5} />
                <DarkStyleButton
                    activeDropdown={activeDropdownIndex}
                    setActiveDropdown={setActiveDropdownIndex}
                    dropdownIndex={6} />
                <AirplaneModeButton
                    activeDropdown={activeDropdownIndex}
                    setActiveDropdown={setActiveDropdownIndex}
                    dropdownIndex={7} />
            </Gtk.FlowBox>
            <SwayGapsWidget
                activeDropdown={activeDropdownIndex}
                dropdownIndex={1} />
            <PowerProfilesWidget
                activeDropdown={activeDropdownIndex}
                dropdownIndex={2} />
            <WifiWidget
                activeDropdown={activeDropdownIndex}
                dropdownIndex={3} />
            <BluetoothWidget
                activeDropdown={activeDropdownIndex}
                dropdownIndex={4} />

        </box>),
        reset() {
            setActiveDropdownIndex(0)
        }
    }
}
