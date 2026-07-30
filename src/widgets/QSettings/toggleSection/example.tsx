import { Gtk } from "ags/gtk4"
import { Accessor, createState, Setter } from "gnim"
import { DropdownButton } from "./ToggleButton"

interface exampleProps {
    activeDropdown: Accessor<number>
    setActiveDropdown: Setter<number>
    dropdownIndex: number
}

interface exampleWidgetProps {
    activeDropdown: Accessor<number>
    dropdownIndex: number
}

let [active, setActive] = createState(false)

export function ExampleButton({
    activeDropdown: activeDropdown,
    setActiveDropdown: setActiveDropdown,
    dropdownIndex: dropdownIndex,
}: exampleProps) {
    const toggle = () => {
        setActive(!active.get())
    }

    return (
        <DropdownButton
            activeDropdown={activeDropdown}
            setActiveDropdown={setActiveDropdown}
            dropdownIndex={dropdownIndex}
            icon={"applications-system-symbolic"}
            label={`example ${dropdownIndex}`}
            isActive={active}
            activate={toggle}
        />
    )
}

export function ExampleWidget({
    activeDropdown: revealChild,
    dropdownIndex: index,
}: exampleWidgetProps) {
    return (
        <revealer revealChild={revealChild.as(s => s === index)}>
            <label
                label={active.as(v => (v ? `example ${index}` : `**Meaw ${index}**`))}
                useMarkup={true}
            />
        </revealer>
    )
}
