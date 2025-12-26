import { Accessor, createBinding, createState, Setter } from "gnim";
import { DropdownButton } from "./ToggleButton";
import SwayGaps from "../../../lib/swayGaps";
import { Gtk } from "ags/gtk4";
import Config from "../../../config";

interface swayGapsProps {
    activeDropdown: Accessor<number>
    setActiveDropdown: Setter<number>
    dropdownIndex: number
}

interface SwayGapsWidgetProps {
    activeDropdown: Accessor<number>
    dropdownIndex: number
}


export function SwayGapsButton({
    activeDropdown: activeDropdown,
    setActiveDropdown: setActiveDropdown,
    dropdownIndex: dropdownIndex
}: swayGapsProps) {
    if (Config.desktopSession !== "sway")
        return <></>
    const swayGaps = SwayGaps.get_default()

    let [active, setActive] = createState(false)
    const toggle = () => {
        setActive(!active.get())
    }

    return <DropdownButton
        activeDropdown={activeDropdown}
        setActiveDropdown={setActiveDropdown}
        dropdownIndex={dropdownIndex}
        icon={"x-tile-panel"}
        label={`SwayGaps`}
        isActive={createBinding(swayGaps, "gap_state")}
        activate={() => swayGaps.toggleGaps()}
    />
}

export function SwayGapsWidget({activeDropdown: revealChild, dropdownIndex: index}: SwayGapsWidgetProps) {
    if (Config.desktopSession !== "sway")
        return <></>
    const swayGaps = SwayGaps.get_default()
    return <revealer
        revealChild={revealChild.as(s => (s === index))}
    >
        <box
            marginTop={4}
            spacing={4}
        >
            <box>
                <label widthChars={3} label={createBinding(swayGaps, "gap_size").as(v => v.toString())} />
                <slider
                    min={0}
                    max={50}
                    step={1}
                    hexpand
                    onChangeValue={({ value }) => {swayGaps.gap_size = value}}
                    value={createBinding(swayGaps, "gap_size")} />
            </box>
            <Gtk.Separator />
        </box>
    </revealer>
}