import { Gtk } from "ags/gtk4";
import { Accessor, createState, Setter } from "gnim";
import { DropdownButton } from "./ToggleButton";
import SwayGaps from "../../../lib/swayGaps";

interface swayGapsProps {
    activeDropdown: Accessor<number>
    setActiveDropdown: Setter<number>
    dropdownIndex: number
}

interface SwayGapsWidgetProps {
    activeDropdown: Accessor<number>
    dropdownIndex: number
}


export function ExampleButton({
    activeDropdown: activeDropdown,
    setActiveDropdown: setActiveDropdown,
    dropdownIndex: dropdownIndex
}: swayGapsProps) {
    const swayGaps= SwayGaps.get_default()

    let [active, setActive] = createState(false)
    const toggle = () => {
        setActive(!active.get())
    }
    
    return <DropdownButton 
        activeDropdown={activeDropdown}
        setActiveDropdown={setActiveDropdown}
        dropdownIndex={dropdownIndex}
        icon={"applications-system-symbolic"}
        label={`example ${dropdownIndex}`}
        isActive={active}
        activate={toggle}
    />        
}

export function ExampleWidget({activeDropdown: revealChild, dropdownIndex: index}: SwayGapsWidgetProps) {
    const swayGaps= SwayGaps.get_default()
    return <revealer
        revealChild={revealChild.as(s => (s === index))}
    >
        <slider
            min={0}
            max={50}
            widthRequest={260}
            onChangeValue={({ value }) => speaker.set_volume(value)}
            value={swayGaps.gapSize} />
    </revealer>
}