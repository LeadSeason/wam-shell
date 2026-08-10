import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango?version=1.0"
import { Accessor, Setter } from "gnim"
import { pressable } from "../../pressable"

/** badge text for a frequency in MHz: "" hides the badge
 *  (2.4GHz gets none, by design) */
export function bandBadgeOf(freq: number): string {
    if (freq >= 5925) return "6G"
    if (freq >= 5000) return "5G"
    return ""
}

/** icon with a small band badge pill overlaid on the bottom-right;
 *  empty badge text renders just the icon. the overlay is wider than
 *  the icon so the badge sits beside the glyph instead of on top of
 *  it (a badge wider than the icon would hide it) */
export function OverlayIcon({
    icon,
    badge,
}: {
    icon: string | Accessor<string>
    badge: string | Accessor<string>
}) {
    const badgeAcc = typeof badge === "string" ? new Accessor(() => badge) : badge
    return (
        <Gtk.Overlay widthRequest={30}>
            <image iconName={icon} pixelSize={20} />
            <label
                $type="overlay"
                cssClasses={badgeAcc.as(b => ["bandBadge", b === "6G" ? "b6" : "b5"])}
                label={badgeAcc}
                visible={badgeAcc.as(b => b !== "")}
                halign={Gtk.Align.END}
                valign={Gtk.Align.END}
            />
        </Gtk.Overlay>
    )
}

interface TbButtonProps {
    label: string | Accessor<string>
    subtitle?: string | Accessor<string>

    icon?: string | Accessor<string>
    /** state classes on the icon image (e.g. the VPN pill's
     *  up/down/pending); undefined for everyone else */
    iconClasses?: Accessor<string[]>
    /** overlaid band badge on the icon (e.g. "5G"); empty hides it */
    badge?: Accessor<string>
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
    iconClasses = undefined,
    badge = undefined,
    isActive = false,
    activate: activate = undefined,
    navigate = undefined,
    activeDropdown: activeDropdown = undefined,
    setActiveDropdown: setDropdown = undefined,
    dropdownIndex: dropdownIndex = 0,
}: TbButtonProps) {
    const toggleDropdown = () => {
        if (!activeDropdown || !setDropdown) return
        if (activeDropdown.get() === dropdownIndex) setDropdown(0)
        else setDropdown(dropdownIndex)
    }

    const hasChevron =
        navigate !== undefined || (activeDropdown !== undefined && setDropdown !== undefined)

    let cssClasses

    if (typeof isActive === "boolean") {
        // Default to inactive always.
        cssClasses = ["toggleButton"]
    } else {
        cssClasses = isActive.as(v =>
            v ? ["toggleButton", "ToggleSectionActive"] : ["toggleButton"],
        )
    }

    const chevronIcon = !hasChevron
        ? ""
        : navigate !== undefined
          ? "go-next-symbolic"
          : activeDropdown!.as(s => (s === dropdownIndex ? "pan-up-symbolic" : "pan-down-symbolic"))

    // the tile is a box, not a button: the press has to be painted by
    // hand (see pressable). The flag lands on the inner body box and
    // propagates up to the tile, which lights it without touching the
    // chevron sitting beside it
    return (
        <box cssName={"button"} hexpand cssClasses={cssClasses}>
            <box spacing={8} hexpand>
                <Gtk.GestureClick
                    button={1}
                    {...pressable(() => {
                        if (activate) activate()
                        else toggleDropdown()
                    })}
                />
                {badge ? (
                    <OverlayIcon icon={icon} badge={badge} />
                ) : (
                    <image iconName={icon} {...(iconClasses ? { cssClasses: iconClasses } : {})} />
                )}
                <box orientation={Gtk.Orientation.VERTICAL} valign={Gtk.Align.CENTER} hexpand>
                    {/* bounded natural width + ellipsize: a wide fallback
                    font (missing Nerd Fonts) must not inflate the card */}
                    <label
                        cssClasses={["toggleTitle"]}
                        label={label}
                        xalign={0}
                        hexpand
                        maxWidthChars={20}
                        ellipsize={Pango.EllipsizeMode.END}
                    />
                    {subtitle !== undefined && (
                        <label
                            cssClasses={["toggleSubtitle"]}
                            label={subtitle}
                            xalign={0}
                            hexpand
                            maxWidthChars={24}
                            ellipsize={Pango.EllipsizeMode.END}
                        />
                    )}
                </box>
            </box>
            {hasChevron && (
                <box cssClasses={["toggleChevron"]}>
                    <image halign={Gtk.Align.END} iconName={chevronIcon} />
                    <Gtk.GestureClick
                        button={1}
                        {...pressable(() => {
                            if (navigate) navigate()
                            else toggleDropdown()
                        })}
                    />
                </box>
            )}
        </box>
    )
}
