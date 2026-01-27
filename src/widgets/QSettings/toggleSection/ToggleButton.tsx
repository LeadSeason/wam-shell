import { Gtk } from "ags/gtk4";
import { Accessor, Setter } from "gnim";

interface TbButtonProps {
    activeDropdown: Accessor<number>
    setActiveDropdown: Setter<number>
    dropdownIndex: number
    label: string | Accessor<string>

    icon?: string | Accessor<string>
    isActive?: boolean | Accessor<boolean>
    activate?: () => void
}

export function DropdownButton({
    activeDropdown: activeDropdown,
    setActiveDropdown: setDropdown,
    dropdownIndex: dropdownIndex,
    icon = "applications-system-symbolic",
    label,
    isActive = false,
    activate: activate = undefined
}: TbButtonProps) {
    const setActiveDropdown = (i: number) => {
        // Toggle
        if (activeDropdown.get() === i)
            setDropdown(0)
        else
            setDropdown(i)
    }

    let cssClasses

    if (typeof (isActive) === "boolean") {
        // Default to inactive always.
        cssClasses = ["toggleButton"]
    } else {
        cssClasses = isActive.as(v => v ? ["toggleButton", "ToggleSectionActive"] : ["toggleButton"])
    }

    return <box cssName={"button"} hexpand cssClasses={cssClasses}>
        <box spacing={5} hexpand>
            <Gtk.GestureClick
                button={1}
                onPressed={() => {
                    if (activate)
                        activate()
                    else
                        setActiveDropdown(dropdownIndex);
                }} />
            <image iconName={icon} />
            <label label={label} />
        </box>
        <box>
            <image halign={Gtk.Align.END} iconName={activeDropdown.as(s => (s === dropdownIndex) ? "arrow-up-symbolic" : "arrow-down-symbolic")} />
            <Gtk.GestureClick
                button={1}
                onPressed={() => {
                    setActiveDropdown(dropdownIndex);
                }} />
        </box>
    </box>
}