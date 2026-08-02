import { createBinding } from "gnim"
import { execAsync } from "../../../lib/metrics"
import GLib from "gi://GLib?version=2.0"
import { DropdownButton } from "./ToggleButton"
import AstalPowerProfiles from "gi://AstalPowerProfiles?version=0.1"
import { Gtk } from "ags/gtk4"

const hasPowerprofilesctl = GLib.find_program_in_path("powerprofilesctl") !== null

export function PowerProfilesButton({ navigate }: { navigate: () => void }) {
    // power-profiles-daemon not installed
    if (!hasPowerprofilesctl) return <></>
    const powerProfiles = AstalPowerProfiles.get_default()

    const icon = createBinding(powerProfiles, "activeProfile").as(
        v => `power-profile-${v}-symbolic`,
    )

    return (
        <DropdownButton
            navigate={navigate}
            icon={icon}
            label={"Power Mode"}
            subtitle={createBinding(powerProfiles, "activeProfile")}
        />
    )
}

// pretty names + one-line descriptions for the daemon's raw profile
// ids; unknown ids fall back to a capitalized form with no description
const PROFILE_INFO: Record<string, { name: string; desc: string }> = {
    performance: {
        name: "Performance",
        desc: "Full speed, higher power draw",
    },
    balanced: {
        name: "Balanced",
        desc: "Everyday performance and efficiency",
    },
    "power-saver": {
        name: "Power Saver",
        desc: "Prioritizes battery life over speed",
    },
}

function profileInfo(id: string): { name: string; desc: string } {
    return (
        PROFILE_INFO[id] ?? {
            name: id.charAt(0).toUpperCase() + id.slice(1).replaceAll("-", " "),
            desc: "",
        }
    )
}

export function PowerProfilesWidget() {
    const powerProfiles = AstalPowerProfiles.get_default()
    const profiles = powerProfiles.get_profiles()

    return (
        <box orientation={Gtk.Orientation.VERTICAL} cssClasses={["paneCard"]} spacing={2}>
            {profiles.map(profile => {
                const active = createBinding(powerProfiles, "activeProfile").as(
                    a => a === profile.profile,
                )
                const info = profileInfo(profile.profile)
                return (
                    <box
                        cssName={"button"}
                        cssClasses={active.as(a => ["paneRow", ...(a ? ["active"] : [])])}
                        spacing={10}
                    >
                        <Gtk.GestureClick
                            button={1}
                            onPressed={() => {
                                execAsync(["powerprofilesctl", "set", profile.profile]).catch(e =>
                                    console.warn(e),
                                )
                            }}
                        />
                        <image
                            iconName={`power-profile-${profile.profile}-symbolic`}
                            pixelSize={16}
                            valign={Gtk.Align.CENTER}
                        />
                        <box orientation={Gtk.Orientation.VERTICAL} hexpand spacing={1}>
                            <label cssClasses={["paneRowName"]} label={info.name} xalign={0} />
                            <label
                                cssClasses={["paneRowDesc"]}
                                label={info.desc}
                                xalign={0}
                                visible={info.desc !== ""}
                            />
                        </box>
                        <image
                            iconName={"object-select-symbolic"}
                            valign={Gtk.Align.CENTER}
                            visible={active}
                        />
                    </box>
                )
            })}
        </box>
    )
}
