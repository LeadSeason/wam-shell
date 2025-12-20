import Gtk from "gi://Gtk?version=4.0";
import { Accessor, createState } from "gnim";
import { DropdownButton } from "./ToggleButton";
import { ExampleButton, ExampleWidget } from "./SwayGaps";


export function ToggleSection() {
    const [activeDropdown, setActiveDropdown] = createState(0);

    return <box cssClasses={["QSSection"]} orientation={Gtk.Orientation.VERTICAL}>
        <box>
            <ExampleButton activeDropdown={activeDropdown} setActiveDropdown={setActiveDropdown} dropdownIndex={1} />
            <ExampleButton activeDropdown={activeDropdown} setActiveDropdown={setActiveDropdown} dropdownIndex={2} />
        </box>
        <ExampleWidget activeDropdown={activeDropdown} dropdownIndex={1}/>
        <ExampleWidget activeDropdown={activeDropdown} dropdownIndex={2}/>
        <box>
            <ExampleButton activeDropdown={activeDropdown} setActiveDropdown={setActiveDropdown} dropdownIndex={3} />
            <ExampleButton activeDropdown={activeDropdown} setActiveDropdown={setActiveDropdown} dropdownIndex={4} />
        </box>
        <ExampleWidget activeDropdown={activeDropdown} dropdownIndex={3}/>
        <ExampleWidget activeDropdown={activeDropdown} dropdownIndex={4}/>
    </box>;
}
