import { createBinding } from "gnim";
import { execAsync } from "ags/process";
import GLib from "gi://GLib?version=2.0";
import { DropdownButton } from "./ToggleButton";
import AstalPowerProfiles from "gi://AstalPowerProfiles?version=0.1";
import { Gtk } from "ags/gtk4";

const hasPowerprofilesctl =
    GLib.find_program_in_path("powerprofilesctl") !== null

export function PowerProfilesButton({ navigate }: { navigate: () => void }) {
    // power-profiles-daemon not installed
    if (!hasPowerprofilesctl) return <></>
    const powerProfiles = AstalPowerProfiles.get_default()

    const icon = createBinding(powerProfiles, "activeProfile").as(v => `power-profile-${v}-symbolic`)

    return <DropdownButton
        navigate={navigate}
        icon={icon}
        label={"Power Mode"}
        subtitle={createBinding(powerProfiles, "activeProfile")}
    />
}

export function PowerProfilesWidget() {
    const powerProfiles = AstalPowerProfiles.get_default()
    const profiles = powerProfiles.get_profiles()

    return <box orientation={Gtk.Orientation.VERTICAL}>
        {profiles.map((profile) => {
            const activeCss = createBinding(powerProfiles, "activeProfile").as(
                (active) => (active === profile.profile) ? ["active"] : [""])
            return (
                <box
                    cssName={"button"}
                    cssClasses={activeCss}
                >
                    <Gtk.GestureClick
                        button={1}
                        onPressed={() => {
                            execAsync(["powerprofilesctl", "set", profile.profile])
                                .catch((e) => console.warn(e))
                        }}
                    />
                    <label label={profile.profile} hexpand xalign={0} />
                </box>
            )
        })}
    </box>
}
