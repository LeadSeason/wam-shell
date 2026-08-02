import { Accessor, createBinding, createComputed, onCleanup } from "gnim"
import { execAsync } from "../../../lib/metrics"
import GLib from "gi://GLib?version=2.0"
import Pango from "gi://Pango?version=1.0"
import { DropdownButton } from "./ToggleButton"
import AstalPowerProfiles from "gi://AstalPowerProfiles?version=0.1"
import AstalBattery from "gi://AstalBattery?version=0.1"
import { Gtk } from "ags/gtk4"
import * as Power from "../../../lib/powerDetails"

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

function PowerDetails() {
    const bat = AstalBattery.get_default()

    // seconds -> "3 h 12 min"
    const span = (seconds: number): string => {
        const h = Math.floor(seconds / 3600)
        const m = Math.floor((seconds % 3600) / 60)
        return h > 0 ? `~${h} h ${m} min` : `~${m} min`
    }

    function row(key: string, value: any, visible: any = true) {
        return (
            <box visible={visible}>
                <label cssClasses={["key"]} label={key} xalign={0} hexpand />
                <label
                    cssClasses={["value"]}
                    label={value}
                    xalign={1}
                    maxWidthChars={30}
                    ellipsize={Pango.EllipsizeMode.END}
                />
            </box>
        )
    }

    return (
        <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
            <label cssClasses={["paneSection"]} label={"Power details"} xalign={0} hexpand />
            <box cssClasses={["paneCard", "wifiDetails"]} orientation={Gtk.Orientation.VERTICAL}>
                {row(
                    "Battery",
                    createBinding(bat, "energyRate").as(r =>
                        r < 0 ? `+${Math.abs(r).toFixed(1)} W (charging)` : `${r.toFixed(1)} W`,
                    ),
                    bat.isPresent,
                )}
                {row(
                    "Time left",
                    createComputed(
                        [
                            createBinding(bat, "timeToEmpty"),
                            createBinding(bat, "timeToFull"),
                            createBinding(bat, "charging"),
                        ],
                        (toEmpty, toFull, charging) => span(Number(charging ? toFull : toEmpty)),
                    ),
                    bat.isPresent,
                )}
                {row(
                    "CPU frequency",
                    createComputed([Power.freqAvgMhz, Power.freqCapMhz], (avg, cap) =>
                        cap > 0
                            ? `${(avg / 1000).toFixed(1)} of ${(cap / 1000).toFixed(1)} GHz (${Math.round((avg / cap) * 100)}%)`
                            : `${(avg / 1000).toFixed(1)} GHz`,
                    ),
                    Power.hasFreq,
                )}
                {row(
                    "Governor",
                    Power.governor.as(g => g || "—"),
                    Power.hasFreq,
                )}
                {row(
                    "Energy preference",
                    Power.epp.as(e => e || "—"),
                    Power.hasFreq,
                )}
                {row(
                    "CPU temperature",
                    Power.tempC.as(t => `${t} °C`),
                    Power.hasTemp,
                )}
                {row(
                    "Fan",
                    Power.fanRpm.as(r => `${r} RPM`),
                    Power.hasFan,
                )}
            </box>
        </box>
    )
}

export function PowerProfilesWidget({ pane, name }: { pane: Accessor<string>; name: string }) {
    const powerProfiles = AstalPowerProfiles.get_default()
    const profiles = powerProfiles.get_profiles()

    // the details poll runs only while this pane is on screen
    const unsub = pane.subscribe(() => Power.setActive(pane.get() === name))
    onCleanup(unsub)

    return (
        <box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
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
                                    execAsync(["powerprofilesctl", "set", profile.profile]).catch(
                                        e => console.warn(e),
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
            <PowerDetails />
        </box>
    )
}
