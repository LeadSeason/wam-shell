import { Accessor, createBinding, createState, For, Setter } from "gnim";
import { DropdownButton } from "./ToggleButton";
import AstalPowerProfiles from "gi://AstalPowerProfiles?version=0.1";
import { Gtk } from "ags/gtk4";

interface powerProfilesProps {
    activeDropdown: Accessor<number>
    setActiveDropdown: Setter<number>
    dropdownIndex: number
}

interface powerProfilesWidgetProps {
    activeDropdown: Accessor<number>
    dropdownIndex: number
}

export function PowerProfilesButton({
    activeDropdown: activeDropdown,
    setActiveDropdown: setActiveDropdown,
    dropdownIndex: dropdownIndex
}: powerProfilesProps) {

    const powerProfiles = AstalPowerProfiles.get_default()

    const icon = createBinding(powerProfiles, "activeProfile").as(v => `power-profile-${v}-symbolic`)
    const label = createBinding(powerProfiles, "activeProfile")

    return <DropdownButton
        activeDropdown={activeDropdown}
        setActiveDropdown={setActiveDropdown}
        dropdownIndex={dropdownIndex}
        icon={icon}
        label={label}
    />
}

export function PowerProfilesWidget({ activeDropdown: revealChild, dropdownIndex: index }: powerProfilesWidgetProps) {
    const powerProfiles = AstalPowerProfiles.get_default()
    const profiles = powerProfiles.get_profiles()

    return <revealer
        revealChild={revealChild.as(s => (s === index))}
    >
        <box>
            {profiles.map((profile) => {
                const activeCss = createBinding(powerProfiles, "activeProfile").as(
                    (active) => (active === profile.profile) ? ["active"] : [""])
                return (
                    <box
                        orientation={Gtk.Orientation.VERTICAL}
                        cssName={"button"}
                        cssClasses={activeCss}
                    >
                        <label label={profile.profile} />
                        <Gtk.GestureClick
                            button={1}
                            onPressed={() => {
                                powerProfiles.set_active_profile(profile.profile)
                            }}
                        />
                    </box>
                )
            })}
        </box>
    </revealer>
}