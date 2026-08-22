import { Accessor, createBinding, createComputed, createState, For, onCleanup } from "gnim"
import { execAsync } from "../../../lib/metrics"
import GLib from "gi://GLib?version=2.0"
import Pango from "gi://Pango?version=1.0"
import { DropdownButton } from "./ToggleButton"
import AstalPowerProfiles from "gi://AstalPowerProfiles?version=0.1"
import AstalBattery from "gi://AstalBattery?version=0.1"
import { Gdk, Gtk } from "ags/gtk4"
import Config from "../../../config"
import * as Power from "../../../lib/powerDetails"
import { atChargeLimit } from "../../../lib/batteryCap"
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
    // the wrapper behind as a full blank cell in the homogeneous grid
    // (see vpn.tsx's note)
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

// one titled group of tiles: an eyebrow (the panes' shared
// .paneSection) over its own 2-column grid. The whole section hides
// when every tile in it is gated off (no battery, show_stats off, …)
function TileSection({
    title,
    visible = true,
    children,
}: {
    title: string
    visible?: boolean | Accessor<boolean>
    children: Gtk.Widget | Gtk.Widget[]
}) {
    return (
        <box orientation={Gtk.Orientation.VERTICAL} spacing={8} visible={visible}>
            <label cssClasses={["paneSection"]} xalign={0} label={title} hexpand />
            <Gtk.FlowBox
                maxChildrenPerLine={2}
                homogeneous
                selectionMode={Gtk.SelectionMode.NONE}
                columnSpacing={8}
                rowSpacing={8}
            >
                {children}
            </Gtk.FlowBox>
        </box>
    )
}

// One GPU at a time, paged like the media card's player switcher:
// scroll anywhere over the tiles, arrow keys while the pointer is on
// them, or click a segment in the strip down the left edge.
//
// A carousel rather than one grid holding every card, because nothing
// here is comparable across cards: amdgpu and nvidia have separate
// sensors, separate memory pools and separate per-process accounting,
// and two cards' tiles side by side invite exactly the misreading the
// pressure warning used to make.
function GpuSection() {
    let card: Gtk.Box

    const tiles = Sys.activeGpu
    const show = Sys.gpuIds.as(l => l.length > 0 && Config.quicksettings.showStats)

    return (
        <box orientation={Gtk.Orientation.VERTICAL} spacing={8} visible={show}>
            {/* the eyebrow carries the card's name: with the tiles
            paged, which GPU you are looking at is not otherwise on
            screen anywhere */}
            <label
                cssClasses={["paneSection"]}
                xalign={0}
                hexpand
                label={tiles.as(g => (g ? `GPU · ${g.name}` : "GPU"))}
                maxWidthChars={36}
                ellipsize={Pango.EllipsizeMode.END}
            />
            <box
                spacing={8}
                // arrow keys page cards while hovering; the box takes
                // focus on pointer enter, never from a text entry
                focusable
                $={self => {
                    card = self
                }}
            >
                <Gtk.EventControllerMotion
                    onEnter={() => {
                        const root = card.get_root() as Gtk.Window | null
                        const focus = root?.get_focus()
                        if (focus instanceof Gtk.Entry || focus instanceof Gtk.Text) return
                        card.grab_focus()
                    }}
                    onLeave={() => {
                        const root = card.get_root() as Gtk.Window | null
                        if (root?.get_focus() === card) root.set_focus(null)
                    }}
                />
                <Gtk.EventControllerKey
                    onKeyPressed={(_e, keyval) => {
                        if (keyval === Gdk.KEY_Up) {
                            Sys.cycleActiveGpu(-1)
                            return true
                        }
                        if (keyval === Gdk.KEY_Down) {
                            Sys.cycleActiveGpu(1)
                            return true
                        }
                        return false
                    }}
                />
                <Gtk.EventControllerScroll
                    flags={Gtk.EventControllerScrollFlags.VERTICAL}
                    onScroll={(_e, _dx, dy) => {
                        Sys.scrollActiveGpu(dy)
                        return true
                    }}
                />
                {/* scroll-position strip on the left edge, one segment
                per card with the shown one lit — the media card's
                pattern, down to the class shape. A <For> over gpuIds,
                NOT over gpus: the latter is a fresh array every poll
                tick and would rebuild these widgets once a second */}
                <box
                    cssClasses={["gpuSegments"]}
                    orientation={Gtk.Orientation.VERTICAL}
                    spacing={2}
                    visible={Sys.gpuIds.as(l => l.length > 1)}
                >
                    <For each={Sys.gpuIds}>
                        {g => (
                            <box
                                vexpand
                                cssClasses={Sys.activeGpuId.as(id => [
                                    "gpuSegment",
                                    ...(g.id === id ? ["active"] : []),
                                ])}
                                tooltipText={g.name}
                            >
                                <Gtk.GestureClick
                                    button={1}
                                    onPressed={() => Sys.selectGpu(g.id)}
                                />
                            </box>
                        )}
                    </For>
                </box>
                <Gtk.FlowBox
                    maxChildrenPerLine={2}
                    homogeneous
                    hexpand
                    selectionMode={Gtk.SelectionMode.NONE}
                    columnSpacing={8}
                    rowSpacing={8}
                >
                    <StatTile
                        icon="gpu-symbolic"
                        big={tiles.as(g => (g?.busy !== null && g ? `${g.busy}%` : "—"))}
                        sub={tiles.as(g => Sys.formatGpuSub(g?.temp ?? null, g?.clock ?? null))}
                        visible={tiles.as(g => g !== null)}
                    />
                    {/* PPT on amdgpu is the WHOLE SoC's budget, CPU
                    cores included, so it is never called "GPU power";
                    nvidia's power.draw really is the board. Same bolt
                    as the CPU package tile — a second gpu-symbolic here
                    would read as a repeat of the tile above */}
                    <StatTile
                        icon="power-profile-performance-symbolic"
                        big={tiles.as(g => (g?.watts != null ? `${g.watts.toFixed(1)} W` : "—"))}
                        sub={tiles.as(g => (g?.vendor === "amd" ? "package (PPT)" : "board"))}
                        visible={tiles.as(g => g?.watts != null)}
                    />
                    {/* VRAM and GTT get a tile EACH rather than one
                    tile with GTT in its sub: measured at the pane's
                    440px, the combined spelling is 217px against a
                    208px per-column budget and flips this FlowBox to a
                    single column. Split, both land near 164px. The
                    percentage leads, matching the RAM tile in System */}
                    <StatTile
                        icon="memory-symbolic"
                        big={tiles.as(g => `${Sys.poolPct(g?.vram[0] ?? 0, g?.vram[1] ?? 0)}%`)}
                        sub={tiles.as(g =>
                            Sys.formatGpuPool("VRAM", g?.vram[0] ?? 0, g?.vram[1] ?? 0),
                        )}
                        visible={tiles.as(g => (g?.vram[1] ?? 0) > 0)}
                    />
                    {/* amdgpu only — nvidia has no GTT. The host icon,
                    not a second memory-symbolic: GTT is system RAM the
                    GPU borrows, and two identical icons in one grid
                    read as one repeated stat */}
                    <StatTile
                        icon="computer-symbolic"
                        big={tiles.as(g => `${Sys.poolPct(g?.gtt?.[0] ?? 0, g?.gtt?.[1] ?? 0)}%`)}
                        sub={tiles.as(g =>
                            Sys.formatGpuPool("GTT", g?.gtt?.[0] ?? 0, g?.gtt?.[1] ?? 0),
                        )}
                        visible={tiles.as(g => (g?.gtt?.[1] ?? 0) > 0)}
                    />
                </Gtk.FlowBox>
            </box>
        </box>
    )
}

// big-number tiles grouped by what they measure: battery, the system
// stats (moved from the main pane), CPU, GPU and the network totals.
// CPU and GPU are deliberately adjacent and deliberately the same
// shape — utilisation, then thermals/clock, then power — so the two
// read as a pair rather than as two unrelated lists
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
    const batState = createBinding(bat, "state")
    const freqPct = createComputed([Power.freqAvgMhz, Power.freqCapMhz], (avg, cap) =>
        cap > 0 ? avg / cap : 1,
    )

    return (
        <box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
            <TileSection title={"Battery"} visible={bat.isPresent}>
                <StatTile
                    icon="battery-symbolic"
                    big={watts.as(r => `${Math.abs(r).toFixed(1)} W`)}
                    sub={createComputed(
                        [
                            watts,
                            charging,
                            createBinding(bat, "percentage"),
                            Power.battAvgWatts,
                            batState,
                        ],
                        (r, c, pct, avg, s) => {
                            // at the limit and HELD there by the adapter
                            // the battery holds its charge — say so.
                            // atChargeLimit, not the percentage alone: a
                            // battery discharging at the cap is NOT on AC
                            if (atChargeLimit(pct, s))
                                return avg > 0 ? `on AC · ${avg.toFixed(1)} W` : "on AC"
                            // state from the battery, not the rate's sign:
                            // plenty of firmware reports a POSITIVE
                            // energyRate while charging. DISCHARGING wins
                            // over the charging flag, which flickers at
                            // the cap — the very case that falls through
                            const state =
                                s === AstalBattery.State.DISCHARGING || !c
                                    ? "discharging"
                                    : "charging"
                            // trailing 5-minute average once the ring fills
                            return avg > 0 ? `${state} · ${avg.toFixed(1)} W` : state
                        },
                    )}
                    visible={bat.isPresent}
                />
                <StatTile
                    icon="hourglass-symbolic"
                    bigClasses={createComputed(
                        [createBinding(bat, "percentage"), batState],
                        (p, s) => (atChargeLimit(p, s) ? ["statTileSub"] : ["statTileValue"]),
                    )}
                    center={createComputed([createBinding(bat, "percentage"), batState], (p, s) =>
                        atChargeLimit(p, s),
                    )}
                    big={createComputed(
                        [
                            createBinding(bat, "timeToEmpty"),
                            createBinding(bat, "timeToFull"),
                            createBinding(bat, "charging"),
                            createBinding(bat, "percentage"),
                            batState,
                        ],
                        (toEmpty, toFull, charging, pct, s) => {
                            // held at the charge limit UPower's times are
                            // junk (0 min) — same check as the header; a
                            // battery discharging at the cap has a valid
                            // timeToEmpty and falls through
                            if (atChargeLimit(pct, s)) return "Charge limit"
                            return span(Number(charging ? toFull : toEmpty))
                        },
                    )}
                    sub={createComputed(
                        [
                            createBinding(bat, "charging"),
                            createBinding(bat, "percentage"),
                            batState,
                        ],
                        (c, pct, s) =>
                            atChargeLimit(pct, s) ? "" : c ? "until full" : "at current draw",
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
            </TileSection>
            {/* moved stats (gated by show_stats) */}
            {/* `|| hasFan` keeps the fan reading alive when show_stats
            is off: powerDetails polls it whenever the pane is open,
            independent of the stats poll, and it showed unconditionally
            back when it rode the CPU temperature tile */}
            <TileSection title={"System"} visible={Config.quicksettings.showStats || Power.hasFan}>
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
                <StatTile
                    icon="drive-harddisk-symbolic"
                    big={Sys.diskRead.as(r => `↓ ${Sys.formatRate(r)}`)}
                    sub={Sys.diskWrite.as(w => `↑ ${Sys.formatRate(w)}`)}
                    visible={Config.quicksettings.showStats}
                />
                {/* the CHASSIS fan, not a CPU one: powerDetails finds
                it on a laptop vendor's hwmon (thinkpad/asus/dell/…) and
                deliberately skips GPU fans, so it cools the whole box
                and belongs here rather than under CPU. Not gated on
                show_stats — see the section's own flag */}
                <StatTile
                    icon="fan-symbolic"
                    big={Power.fanRpm.as(r => `${r} RPM`)}
                    sub={"chassis fan"}
                    visible={Power.hasFan}
                />
                <StatTile
                    icon="document-open-recent-symbolic"
                    big={Sys.uptimeSeconds.as(s => Sys.formatUptime(s))}
                    sub={"uptime"}
                    visible={Config.quicksettings.showStats}
                />
            </TileSection>
            <TileSection
                title={"CPU"}
                visible={
                    Power.hasFreq || Power.hasTemp || Power.hasPkg || Config.quicksettings.showStats
                }
            >
                {/* utilisation first, so this section and the GPU one
                below open on the same number. showStats gates only this
                tile, which is why it also has to widen the section's
                own visible flag — a machine with no cpufreq, no hwmon
                and an unreadable RAPL counter would otherwise hide the
                section out from under it */}
                <StatTile
                    icon="speedometer-symbolic"
                    big={Sys.cpu.as(c => `${c}%`)}
                    sub={Sys.loadAvg.as(l => `load ${l.toFixed(2)}`)}
                    visible={Config.quicksettings.showStats}
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
                {/* the k10temp/coretemp package sensor (thermal_zone0
                when neither is exposed) — the fan that used to ride
                this tile's sub is a CHASSIS fan and now lives in
                System, see the note there */}
                <StatTile
                    icon="temperature-symbolic"
                    big={Power.tempC.as(t => `${t} °C`)}
                    sub={"package"}
                    visible={Power.hasTemp}
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
            </TileSection>
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
            <GpuSection />
            <TileSection
                title={"Network"}
                visible={Config.quicksettings.showStats || Config.netstats.enabled}
            >
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
            </TileSection>
        </box>
    )
}

// the "your machine is thrashing" notice: PSI says tasks have been
// stalled on memory for a sustained stretch (avg60, not the
// launch-an-app avg10 spike). Always built, visible-gated — a late
// conditional build would append it AFTER the details tiles
function MemPressureWarning() {
    const level = Sys.memPressure.as(p =>
        p === null || p < Sys.MEM_PRESSURE_WARN
            ? ""
            : p >= Sys.MEM_PRESSURE_CRIT
              ? "critical"
              : "warn",
    )
    const desc = createComputed([Sys.memPressure, Sys.swapSize], (p, [sw, swTotal]) => {
        // short on purpose: the line ellipsizes at the pane's width,
        // and a cut-off middle loses the numbers that matter
        const stalls = `stalled ${Math.round(p ?? 0)}% of last min`
        return swTotal > 0 ? `${stalls} · swap ${sw}/${swTotal} GB` : stalls
    })
    return (
        <box
            cssClasses={level.as(l => [
                "paneCard",
                "memPressure",
                ...(l === "critical" ? ["critical"] : []),
            ])}
            spacing={10}
            visible={level.as(l => l !== "")}
        >
            <image iconName="dialog-warning-symbolic" pixelSize={20} valign={Gtk.Align.CENTER} />
            <box orientation={Gtk.Orientation.VERTICAL} spacing={1} hexpand>
                <label
                    cssClasses={["paneRowName"]}
                    xalign={0}
                    label={level.as(l =>
                        l === "critical" ? "Severe memory pressure" : "High memory pressure",
                    )}
                />
                {/* both text lines ellipsize: a label without it makes
                its FULL text the scrolled window's minimum width (the
                hscrollbar never shows), so every digit change resized
                the popup and a long hog line stretched the tile grid
                past its design width */}
                <label
                    cssClasses={["paneRowDesc"]}
                    xalign={0}
                    label={desc}
                    maxWidthChars={44}
                    ellipsize={Pango.EllipsizeMode.END}
                />
                {/* the "who to kill" line: the biggest residents, only
                while pressure is high (memHogs is "" below WARN) */}
                <label
                    cssClasses={["paneRowDesc", "memHogs"]}
                    xalign={0}
                    visible={Sys.memHogs.as(h => h !== "")}
                    label={Sys.memHogs.as(h => `mostly: ${h}`)}
                    maxWidthChars={44}
                    ellipsize={Pango.EllipsizeMode.END}
                />
            </box>
        </box>
    )
}

// the GPU-memory twin of the notice above: no PSI for GPU memory, so
// "pressure" is plain used/total %. A saturated VRAM carve-out is a
// compositor crash, not sluggishness — same warn/crit treatment as RAM.
//
// One PAGE per saturated card, paged like the GPU tiles below: scroll,
// arrow keys while hovered, or click a segment. Two cards over the line
// used to report as one, because the warning kept a single "worst"
// card and never mentioned the other — and the detail line ellipsizes
// long before two cards' figures fit on it. Paging also lets each card
// blame its own processes, which is the only correct answer: the two
// have entirely separate accounting.
function VramPressureWarning() {
    let card: Gtk.Box
    const page = Sys.activePressure

    return (
        <box
            cssClasses={page.as(p => [
                "paneCard",
                "vramPressure",
                ...(p?.level === "critical" ? ["critical"] : []),
            ])}
            spacing={10}
            visible={page.as(p => p !== null)}
            focusable
            $={self => {
                card = self
            }}
        >
            <Gtk.EventControllerMotion
                onEnter={() => {
                    const root = card.get_root() as Gtk.Window | null
                    const focus = root?.get_focus()
                    if (focus instanceof Gtk.Entry || focus instanceof Gtk.Text) return
                    card.grab_focus()
                }}
                onLeave={() => {
                    const root = card.get_root() as Gtk.Window | null
                    if (root?.get_focus() === card) root.set_focus(null)
                }}
            />
            <Gtk.EventControllerKey
                onKeyPressed={(_e, keyval) => {
                    if (keyval === Gdk.KEY_Up) {
                        Sys.cycleActivePressure(-1)
                        return true
                    }
                    if (keyval === Gdk.KEY_Down) {
                        Sys.cycleActivePressure(1)
                        return true
                    }
                    return false
                }}
            />
            <Gtk.EventControllerScroll
                flags={Gtk.EventControllerScrollFlags.VERTICAL}
                onScroll={(_e, _dx, dy) => {
                    Sys.scrollActivePressure(dy)
                    return true
                }}
            />
            {/* the strip only appears with a second card in trouble */}
            <box
                cssClasses={["gpuSegments"]}
                orientation={Gtk.Orientation.VERTICAL}
                spacing={2}
                visible={Sys.gpuPressureIds.as(l => l.length > 1)}
            >
                <For each={Sys.gpuPressureIds}>
                    {g => (
                        <box
                            vexpand
                            cssClasses={Sys.activePressureId.as(id => [
                                "gpuSegment",
                                ...(g.id === id ? ["active"] : []),
                            ])}
                            tooltipText={g.name}
                        >
                            <Gtk.GestureClick
                                button={1}
                                onPressed={() => Sys.selectPressure(g.id)}
                            />
                        </box>
                    )}
                </For>
            </box>
            <image iconName="dialog-warning-symbolic" pixelSize={20} valign={Gtk.Align.CENTER} />
            <box orientation={Gtk.Orientation.VERTICAL} spacing={1} hexpand>
                {/* the count is the only thing that says the trouble is
                not confined to the card on screen; the detail line has
                no width to spare for it */}
                <label
                    cssClasses={["paneRowName"]}
                    xalign={0}
                    label={createComputed([page, Sys.gpuPressureIds], (p, l) => {
                        const head =
                            p?.level === "critical"
                                ? "Severe GPU memory pressure"
                                : "High GPU memory pressure"
                        return l.length > 1 ? `${head} · ${l.length} cards` : head
                    })}
                />
                {/* both text lines ellipsize — see the RAM card for why */}
                <label
                    cssClasses={["paneRowDesc"]}
                    xalign={0}
                    label={page.as(p => p?.desc ?? "")}
                    maxWidthChars={44}
                    ellipsize={Pango.EllipsizeMode.END}
                />
                {/* this card's biggest consumers. Shown or hidden for
                the WHOLE carousel at once: bound to the active page it
                would resize the card mid-scroll, under the pointer */}
                <label
                    cssClasses={["paneRowDesc", "gpuMemHogs"]}
                    xalign={0}
                    visible={Sys.gpuHogsShown}
                    label={page.as(p => p?.hogs ?? "")}
                    maxWidthChars={44}
                    ellipsize={Pango.EllipsizeMode.END}
                />
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
            <MemPressureWarning />
            <VramPressureWarning />
            <PowerDetails />
        </box>
    )
}
