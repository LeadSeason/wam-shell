import { Gtk } from "ags/gtk4";
import { Accessor, Setter } from "gnim";

interface TbButtonProps {
    label: string | Accessor<string>

    icon?: string | Accessor<string>
    isActive?: boolean | Accessor<boolean>
    activate?: () => void

    /**
     * Shown on click of the chevron.
     * navigate -> switch to a different pane, chevron points right.
     * activeDropdown/setActiveDropdown/dropdownIndex -> inline dropdown,
     * chevron points up/down. Neither -> chevron hidden.
     */
    navigate?: () => void
    activeDropdown?: Accessor<number>
    setActiveDropdown?: Setter<number>
    dropdownIndex?: number
}

export function DropdownButton({
    label,
    icon = "applications-system-symbolic",
    isActive = false,
    activate: activate = undefined,
    navigate = undefined,
    activeDropdown: activeDropdown = undefined,
    setActiveDropdown: setDropdown = undefined,
    dropdownIndex: dropdownIndex = 0,
}: TbButtonProps) {
    const toggleDropdown = () => {
        if (!activeDropdown || !setDropdown) return
        if (activeDropdown.get() === dropdownIndex)
            setDropdown(0)
        else
            setDropdown(dropdownIndex)
    }

    const hasChevron = navigate !== undefined || (activeDropdown !== undefined && setDropdown !== undefined)

    let cssClasses

    if (typeof (isActive) === "boolean") {
        // Default to inactive always.
        cssClasses = ["toggleButton"]
    } else {
        cssClasses = isActive.as(v => v ? ["toggleButton", "ToggleSectionActive"] : ["toggleButton"])
    }

    const chevronIcon = !hasChevron
        ? ""
        : navigate !== undefined
            ? "go-next-symbolic"
            : activeDropdown!.as(s => (s === dropdownIndex) ? "arrow-up-symbolic" : "arrow-down-symbolic")

    return <box cssName={"button"} hexpand cssClasses={cssClasses}>
        <box spacing={5} hexpand>
            <Gtk.GestureClick
                button={1}
                onPressed={() => {
                    if (activate)
                        activate()
                    else
                        toggleDropdown();
                }} />
            <image iconName={icon} />
            <label label={label} />
        </box>
        {hasChevron &&
            <box>
                <image halign={Gtk.Align.END} iconName={chevronIcon} />
                <Gtk.GestureClick
                    button={1}
                    onPressed={() => {
                        if (navigate)
                            navigate()
                        else
                            toggleDropdown();
                    }} />
            </box>
        }
    </box>
}
