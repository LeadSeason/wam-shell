import { Accessor, createBinding, createComputed, createState, onCleanup } from "gnim"
import { execAsync } from "../../../lib/metrics"
import GLib from "gi://GLib?version=2.0"
import Pango from "gi://Pango?version=1.0"
import { DropdownButton } from "./ToggleButton"
import AstalPowerProfiles from "gi://AstalPowerProfiles?version=0.1"
import AstalBattery from "gi://AstalBattery?version=0.1"
import { Gtk } from "ags/gtk4"
import Config from "../../../config"
import * as Power from "../../../lib/powerDetails"
import * as Sys from "../../../lib/sysstats"
import * as Net from "../../../lib/netTotals"
import * as Energy from "../../../lib/energyTotals"

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
            subtitle={createBinding(powerProfiles, "activeProfile").as(v => profileInfo(v).name)}
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

export function profileInfo(id: string): { name: string; desc: string } {
    return (
        PROFILE_INFO[id] ?? {
            name: id.charAt(0).toUpperCase() + id.slice(1).replaceAll("-", " "),
            desc: "",
        }
    )
}

// static fallback for StatTile's center flag (the notification
// center's FALSE pattern)
const [FALSE] = createState(false)

function StatTile({
    icon,
    big,
    sub,
    bigClasses = ["statTileValue"],
    center = FALSE,
    visible = true,
}: {
    icon: string
    big: string | Accessor<string>
    sub: string | Accessor<string>
    // e.g. ["statTileSub"] for text that shouldn't get the big-number size
    bigClasses?: string[] | Accessor<string[]>
    // center the text block (single-string tiles, e.g. "Charge limit")
    center?: Accessor<boolean>
    visible?: boolean | Accessor<boolean>
}) {
    // the holder is a FlowBoxChild, not the tile box: a FlowBox lays out
    // only visible FlowBoxChildren, so `visible` on the inner box leaves
    // the wrapper behind as a full blank cell in the homogeneous grid —
    // with show_stats off that's a hole in the MIDDLE of the grid now
    // that the netstats tiles follow the stats ones (see vpn.tsx's note)
    return (
        <Gtk.FlowBoxChild visible={visible}>
            <box cssClasses={["statTile"]} spacing={10}>
                <image iconName={icon} pixelSize={20} valign={Gtk.Align.CENTER} />
                <box hexpand />
                <box
                    orientation={Gtk.Orientation.VERTICAL}
                    spacing={2}
                    valign={Gtk.Align.CENTER}
                    halign={center.as(v => (v ? Gtk.Align.CENTER : Gtk.Align.FILL))}
                >
                    <label
                        cssClasses={bigClasses}
                        label={big}
                        xalign={center.as(v => (v ? 0.5 : 1))}
                        maxWidthChars={16}
                        ellipsize={Pango.EllipsizeMode.END}
                    />
                    <label
                        cssClasses={["statTileSub"]}
                        label={sub}
                        xalign={center.as(v => (v ? 0.5 : 1))}
                        maxWidthChars={20}
                        ellipsize={Pango.EllipsizeMode.END}
                    />
                </box>
            </box>
        </Gtk.FlowBoxChild>
    )
}

// big-number tiles: power details and (moved from the main pane) the
// performance stats, in one 2-column grid
function PowerDetails() {
    const bat = AstalBattery.get_default()

    // seconds -> "3 h 12 min"
    const span = (seconds: number): string => {
        const h = Math.floor(seconds / 3600)
        const m = Math.floor((seconds % 3600) / 60)
        return h > 0 ? `~${h} h ${m} min` : `~${m} min`
    }

    const watts = createBinding(bat, "energyRate")
    const charging = createBinding(bat, "charging")
    const freqPct = createComputed([Power.freqAvgMhz, Power.freqCapMhz], (avg, cap) =>
        cap > 0 ? avg / cap : 1,
    )

    return (
        <box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
            <Gtk.FlowBox
                maxChildrenPerLine={2}
                homogeneous
                selectionMode={Gtk.SelectionMode.NONE}
                columnSpacing={8}
                rowSpacing={8}
            >
                <StatTile
                    icon="battery-symbolic"
                    big={watts.as(r => `${Math.abs(r).toFixed(1)} W`)}
                    sub={createComputed([watts, charging, Power.battAvgWatts], (r, c, avg) => {
                        // state from the battery, not the rate's sign:
                        // plenty of firmware reports a POSITIVE
                        // energyRate while charging
                        const state = c ? "charging" : "discharging"
                        // trailing 5-minute average once the ring fills
                        return avg > 0 ? `${state} · ${avg.toFixed(1)} W` : state
                    })}
                    visible={bat.isPresent}
                />
                <StatTile
                    icon="hourglass-symbolic"
                    bigClasses={createBinding(bat, "percentage").as(p =>
                        p * 100 >= Config.quicksettings.batteryFullAt - 2
                            ? ["statTileSub"]
                            : ["statTileValue"],
                    )}
                    center={createBinding(bat, "percentage").as(
                        p => p * 100 >= Config.quicksettings.batteryFullAt - 2,
                    )}
                    big={createComputed(
                        [
                            createBinding(bat, "timeToEmpty"),
                            createBinding(bat, "timeToFull"),
                            createBinding(bat, "charging"),
                            createBinding(bat, "percentage"),
                        ],
                        (toEmpty, toFull, charging, pct) => {
                            // at the charge limit UPower's times are
                            // junk (0 min) — same check as the header
                            if (pct * 100 >= Config.quicksettings.batteryFullAt - 2)
                                return "Charge limit"
                            return span(Number(charging ? toFull : toEmpty))
                        },
                    )}
                    sub={createComputed(
                        [createBinding(bat, "charging"), createBinding(bat, "percentage")],
                        (c, pct) =>
                            pct * 100 >= Config.quicksettings.batteryFullAt - 2
                                ? ""
                                : c
                                  ? "until full"
                                  : "at current draw",
                    )}
                    visible={bat.isPresent}
                />
                {/* health is full vs design capacity, read once at
                startup — static for practical purposes */}
                <StatTile
                    icon="battery-full-charged-symbolic"
                    big={`${Power.battHealthPct}%`}
                    sub={"battery health"}
                    visible={Power.hasBattHealth}
                />
                {/* Wh drawn from the battery today: tracked around the
                clock by energyTotals (gauge deltas), independent of
                this pane's polls */}
                <StatTile
                    icon="battery-action-symbolic"
                    big={Energy.todayWh.as(w => Energy.formatWh(w))}
                    sub={"consumed today"}
                    visible={Energy.hasBatt}
                />
                <StatTile
                    icon="cpu-symbolic"
                    big={Power.freqAvgMhz.as(m => `${(m / 1000).toFixed(1)} GHz`)}
                    sub={createComputed([freqPct, Power.freqCapMhz], (pct, cap) => {
                        const of =
                            cap > 0 ? `${Math.round(pct * 100)}% of ${(cap / 1000).toFixed(1)}` : ""
                        return pct < 0.95 && of ? `${of} capped` : of
                    })}
                    visible={Power.hasFreq}
                />
                <StatTile
                    icon="temperature-symbolic"
                    big={createComputed([Power.tempC, Power.fanRpm], (t, r) =>
                        Power.hasTemp ? `${t} °C` : `${r} RPM`,
                    )}
                    sub={createComputed([Power.tempC, Power.fanRpm], (t, r) =>
                        Power.hasTemp && Power.hasFan ? `${r} RPM` : Power.hasFan ? "fan" : "",
                    )}
                    visible={Power.hasTemp || Power.hasFan}
                />
                {/* CPU package power (RAPL): what the profile actually
                throttles. A bolt, not a second cpu-symbolic — the
                frequency tile two cells up already wears that one, and
                two identical icons in one grid read as one repeated
                stat */}
                <StatTile
                    icon="power-profile-performance-symbolic"
                    big={Power.pkgWatts.as(w => `${w.toFixed(1)} W`)}
                    sub={"CPU package"}
                    visible={Power.hasPkg}
                />
                {/* moved stats (gated by show_stats) */}
                <StatTile
                    icon="speedometer-symbolic"
                    big={Sys.cpu.as(c => `${c}%`)}
                    sub={Sys.loadAvg.as(l => `load ${l.toFixed(2)}`)}
                    visible={Config.quicksettings.showStats}
                />
                <StatTile
                    icon="memory-symbolic"
                    big={Sys.ram.as(r => `${r}%`)}
                    sub={createComputed(
                        [Sys.ramSize, Sys.swapSize],
                        ([used, total], [sw, swTotal]) =>
                            swTotal > 0
                                ? `${used}/${total} GB sw ${Math.round((sw / swTotal) * 100)}%`
                                : `${used}/${total} GB`,
                    )}
                    visible={Config.quicksettings.showStats}
                />
                {/* NOT a <With>: the gpu state starts null and answers
                ~1s in, so a conditional build appends the tile at the
                END of the grid. A hidden FlowBoxChild (inside StatTile)
                keeps its slot and lands in place when it appears */}
                <StatTile
                    icon="gpu-symbolic"
                    big={createComputed([Sys.gpu, Sys.gpuWatts], (g, w) =>
                        w > 0 ? `${g}% · ${Math.round(w)} W` : `${g}%`,
                    )}
                    sub={createComputed(
                        [Sys.gpuTemp, Sys.vram],
                        (t, [used, total]) => `${t}°C · ${used}/${total} MiB`,
                    )}
                    visible={Sys.gpu.as(g => g !== null && Config.quicksettings.showStats)}
                />
                <StatTile
                    icon="network-transmit-receive-symbolic"
                    big={Sys.netDown.as(d => `↓ ${Sys.formatRate(d)}`)}
                    sub={Sys.netUp.as(u => `↑ ${Sys.formatRate(u)}`)}
                    visible={Config.quicksettings.showStats}
                />
                {/* cumulative totals: collected around the clock by
                netTotals, independent of this pane's live-rate poll.
                Keep `big` SHORT (just the number): a wide label flips
                the FlowBox to one column and the overflow is clipped,
                not scrolled — the word goes in `sub` */}
                <StatTile
                    icon="network-receive-symbolic"
                    big={Net.todayRx.as(b => `↓ ${Net.formatBytes(b)}`)}
                    sub={Net.todayTx.as(b => `today · ↑ ${Net.formatBytes(b)}`)}
                    visible={Config.netstats.enabled}
                />
                <StatTile
                    icon="x-office-calendar-symbolic"
                    big={Net.monthRx.as(b => `↓ ${Net.formatBytes(b)}`)}
                    sub={Net.monthTx.as(b => `month · ↑ ${Net.formatBytes(b)}`)}
                    visible={Config.netstats.enabled}
                />
                <StatTile
                    icon="drive-harddisk-symbolic"
                    big={Sys.diskRead.as(r => `↓ ${Sys.formatRate(r)}`)}
                    sub={Sys.diskWrite.as(w => `↑ ${Sys.formatRate(w)}`)}
                    visible={Config.quicksettings.showStats}
                />
                <StatTile
                    icon="document-open-recent-symbolic"
                    big={Sys.uptimeSeconds.as(s => Sys.formatUptime(s))}
                    sub={"uptime"}
                    visible={Config.quicksettings.showStats}
                />
            </Gtk.FlowBox>
            {/* full-width tile: the active profile's energy preference,
            live — two sub-size rows so the tile matches the others'
            height. The governor is dropped: on pstate systems it maps
            1:1 to the profile anyway */}
            <box cssClasses={["statTile"]} spacing={10} visible={Power.epp.as(e => e !== "")}>
                <image iconName="cpu-symbolic" pixelSize={20} valign={Gtk.Align.CENTER} />
                <box
                    orientation={Gtk.Orientation.VERTICAL}
                    spacing={2}
                    valign={Gtk.Align.CENTER}
                    hexpand
                >
                    <label cssClasses={["statTileSub"]} xalign={0} label={"Energy preference:"} />
                    <label
                        cssClasses={["statTileSub"]}
                        xalign={0}
                        label={Power.epp.as(e => (e || "—").replaceAll("_", " "))}
                    />
                </box>
            </box>
        </box>
    )
}

export function PowerProfilesWidget({ pane, name }: { pane: Accessor<string>; name: string }) {
    const powerProfiles = AstalPowerProfiles.get_default()
    const profiles = powerProfiles.get_profiles()

    // the details poll and the stats poll run only while this pane is
    // on screen
    const unsub = pane.subscribe(() => {
        const on = pane.get() === name
        Power.setActive(on)
        Sys.setActive(on)
    })
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
