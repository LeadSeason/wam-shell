import Gtk from "gi://Gtk?version=4.0";
import { Accessor, createState } from "gnim";
import { SwayGapsButton, SwayGapsWidget } from "./SwayGaps";
import { PowerProfilesButton, PowerProfilesWidget } from "./powerProfile";

/**
 * @TODO Bluetooth, wifi / network. Basically connecting to network manager profiles
 * @TODO Fix buttons being wonky
 *
 */

export function ToggleSection() {

    const [activeDropdownIndex, setActiveDropdownIndex] = createState(0);

    return <box cssClasses={["QSSection"]} orientation={Gtk.Orientation.VERTICAL}>
        <box>
            <SwayGapsButton
                activeDropdown={activeDropdownIndex}
                setActiveDropdown={setActiveDropdownIndex}
                dropdownIndex={1} />
            <PowerProfilesButton
                activeDropdown={activeDropdownIndex}
                setActiveDropdown={setActiveDropdownIndex}
                dropdownIndex={2} />

        </box>
        <SwayGapsWidget
            activeDropdown={activeDropdownIndex}
            dropdownIndex={1}/>
        <PowerProfilesWidget
            activeDropdown={activeDropdownIndex}
            dropdownIndex={2}/>

    </box>;
}
