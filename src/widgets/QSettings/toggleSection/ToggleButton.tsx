import { Gtk } from "ags/gtk4";
import { Accessor, Setter } from "gnim";

interface TbButtonProps {
    label: string | Accessor<string>
    subtitle?: string | Accessor<string>

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
    subtitle = undefined,
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
            : activeDropdown!.as(s => (s === dropdownIndex) ? "pan-up-symbolic" : "pan-down-symbolic")

    return <box cssName={"button"} hexpand cssClasses={cssClasses}>
        <box spacing={8} hexpand>
            <Gtk.GestureClick
                button={1}
                onPressed={() => {
                    if (activate)
                        activate()
                    else
                        toggleDropdown();
                }} />
            <image iconName={icon} />
            <box orientation={Gtk.Orientation.VERTICAL} valign={Gtk.Align.CENTER} hexpand>
                <label cssClasses={["toggleTitle"]} label={label} xalign={0} />
                {subtitle !== undefined &&
                    <label cssClasses={["toggleSubtitle"]} label={subtitle} xalign={0} />
                }
            </box>
        </box>
        {hasChevron &&
            <box cssClasses={["toggleChevron"]}>
                <image halign={Gtk.Align.END} iconName={chevronIcon} />
                <Gtk.GestureClick
                    button={1}
                    onPressed={() => {
                        console.log(`DEBUG chevron pressed, navigate=${navigate !== undefined}`) // DEBUG: keep until merge
                        if (navigate)
                            navigate()
                        else
                            toggleDropdown();
                    }} />
            </box>
        }
    </box>
}
