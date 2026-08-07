import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import Pango from "gi://Pango?version=1.0"
import AstalWp from "gi://AstalWp?version=0.1"
import { Accessor, createBinding, createComputed, createState, For, onCleanup, With } from "gnim"
import GLib from "gi://GLib?version=2.0"
import { execAsync, idleAdd, sourceRemove } from "../../../lib/metrics"
import { createIconResolver } from "../../../lib/appIcon"
import { PercentEntry } from "../PercentEntry"
import { audioPorts, refreshPorts, setPort } from "../../../lib/audioPorts"
import { inputMeter, METER_CLIENT, meterSupported, outputMeter } from "../../../lib/audioMeter"
import { qsVisible } from "../MediaSection"
import Config from "../../../config"

// The audio pane: what pwvucontrol shows, in the shell.
//
// Everything here drives AstalWp directly except making a device the
// default — astal's Endpoint.set_is_default does not switch it, so that
// one goes through wpctl (the same workaround the slider section uses).
// Routing DOES work through astal: setting Stream.target_endpoint moves
// a stream (verified against a temporary null sink), so no CLI for it.

const audio = () => AstalWp.get_default()?.audio ?? null

// a constant 0 for the rows that carry no level bar: the bar is built
// either way and hidden, so nothing here binds to an undefined value
const [ZERO] = createState(0)

// one resolver for the pane: it caches, and building one per row would
// rebuild the app database for every stream
const iconTheme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default()!)
const resolveIcon = createIconResolver(iconTheme)

/** wireplumber reports pulseaudio-era icon names ("audio-card-analog-pci")
 *  that no current icon theme ships, which is why every device and card
 *  row drew a missing-image box. Use the reported name when it exists,
 *  its -symbolic variant when that does, and otherwise something true
 *  about the node: a card, a microphone, headphones, a display */
function audioIcon(reported: string | null, role: "output" | "input" | "card"): string {
    if (reported && iconTheme.has_icon(reported)) return reported
    if (reported && iconTheme.has_icon(`${reported}-symbolic`)) return `${reported}-symbolic`
    const hint = (reported ?? "").toLowerCase()
    if (hint.includes("headset") || hint.includes("headphone")) return "audio-headphones-symbolic"
    if (hint.includes("hdmi") || hint.includes("displayport")) return "video-display-symbolic"
    if (role === "input") return "audio-input-microphone-symbolic"
    if (role === "card") return "audio-card-symbolic"
    return "audio-speakers-symbolic"
}

/** volume as a slider + percent, shared by app rows and device rows.
 *  Scroll and drag both work, and the value is clamped: a stream can go
 *  past 100% (pipewire allows it) but never past 150%, which is where
 *  clipping starts to be audible on most hardware */
function VolumeRow({
    value,
    onChange,
    max = 1.5,
    meter,
}: {
    value: Accessor<number>
    onChange: (v: number) => void
    max?: number
    /** an optional level bar drawn under the slider, on the slider's own
     *  width so the two read against each other */
    meter?: { level: Accessor<number>; visible: Accessor<boolean> }
}) {
    const clamp = (v: number) => Math.min(max, Math.max(0, v))
    let dragWidth = 200
    let dragStart = 0
    // the knob trails the pointer at a third of its speed, the same
    // damping the main volume slider uses: the row is only ~380px wide
    // for a 0-150% range, so an undamped drag moves ~0.4% per pixel and
    // landing on a specific value is luck
    const DAMP = 0.3
    // past 100% is amplification, not volume: pipewire will happily
    // clip. Warn in the fill and the number, orange first, red where it
    // is almost certainly distorting
    // compared on the SAME rounded number the label shows: a raw 1.004
    // reads "100%" while tripping a v > 1.0 test, so the row went orange
    // while claiming to be at exactly 100
    const heat = value.as(v => {
        const pct = Math.round(v * 100)
        return pct > 125 ? ["hot"] : pct > 100 ? ["over"] : []
    })

    return (
        // the heat classes live on the wrapper, not on the scale: a
        // class list bound onto the intrinsic <slider> did not reach
        // its trough, so the fill stayed accent-coloured past 100%
        <box
            orientation={Gtk.Orientation.VERTICAL}
            hexpand
            cssClasses={heat.as(h => ["audioHeat", ...h])}
        >
            <box spacing={8} hexpand>
                {/* the slider and the level share ONE column, so the
                level is exactly as wide as the control it reports on.
                As sibling ROWS they were not: the level's trailing
                spacer was a guess at the percent column's width and
                missed it by 5px on the right and 11px on the left,
                which is most of why a readout read as a second slider */}
                <box orientation={Gtk.Orientation.VERTICAL} hexpand>
                    <overlay hexpand>
                        <Gtk.GestureDrag
                            button={1}
                            onDragBegin={(gesture, x) => {
                                dragWidth = gesture.get_widget()?.get_width() ?? 200
                                dragStart = clamp((x / dragWidth) * max)
                                onChange(dragStart)
                            }}
                            onDragUpdate={(_g, dx) =>
                                onChange(clamp(dragStart + (dx / dragWidth) * max * DAMP))
                            }
                        />
                        <Gtk.EventControllerScroll
                            flags={Gtk.EventControllerScrollFlags.VERTICAL}
                            onScroll={(_s, _dx, dy) => {
                                // 1% a notch: the whole point of this row is
                                // setting a value, not sweeping through one
                                onChange(clamp(value.get() - dy / 100))
                                return true
                            }}
                        />
                        <slider canTarget={false} hexpand max={max} value={value} />
                    </overlay>
                    {/* the level, in the slider's own heat language:
                    what is coming out, under what was asked for */}
                    <Gtk.LevelBar
                        // the bar is normalised over a 60dB floor, so these
                        // are -3dBFS and -0.6dBFS: where output is close
                        // enough to full scale to actually clip. Warning any
                        // earlier would light up on ordinary loud music,
                        // which peaks near -6dBFS all the time
                        cssClasses={(meter?.level ?? ZERO).as(v => [
                            "audioMeter",
                            ...(v > 0.99 ? ["hot"] : v > 0.95 ? ["over"] : []),
                        ])}
                        hexpand
                        visible={meter?.visible ?? false}
                        valign={Gtk.Align.CENTER}
                        mode={Gtk.LevelBarMode.CONTINUOUS}
                        minValue={0}
                        maxValue={1}
                        value={meter?.level ?? ZERO}
                    />
                </box>
                {/* aligned to the SLIDER, not to the column: the level
                sits below the slider and would otherwise pull the
                percent down to the pair's midpoint */}
                <box valign={Gtk.Align.START}>
                    <PercentEntry
                        value={value}
                        onCommit={onChange}
                        max={max}
                        extraClasses={["audioPercent"]}
                    />
                </box>
            </box>
        </box>
    )
}

/** the mute button every row carries, in the row's trailing slot */
function MuteButton({ node }: { node: AstalWp.Node }) {
    return (
        <box
            cssName="button"
            cssClasses={createBinding(node, "mute").as(m => [
                "audioMute",
                ...(m ? ["active"] : []),
            ])}
            tooltipText={"Mute"}
        >
            <Gtk.GestureClick button={1} onPressed={() => (node.mute = !node.mute)} />
            <image iconName={createBinding(node, "volumeIcon")} />
        </box>
    )
}

const EXPAND_CAP = 168

/** what an expandable row unfolds into. Capped and scrollable on its
 *  own: a card with seven profiles used to push the whole pane, so
 *  picking one meant chasing the list as it scrolled away.
 *
 *  Rows inside it need `hexpand` on their label. maxWidthChars caps a
 *  label's NATURAL request, and a horizontal box hands each child
 *  exactly its natural width unless the child expands — so without it
 *  the cap became the allocation and the text ellipsized at 30
 *  characters with half the row still empty. In a VERTICAL box (the
 *  two-line rows above) the child gets the full cross-axis width
 *  already, which is why those clip only when they genuinely run out.
 *
 *  A ScrolledWindow with propagateNaturalHeight measures its child ONCE
 *  and never revisits it, and a `For` appends its rows after
 *  construction — so the box is empty at the only moment the
 *  ScrolledWindow ever looks at it, and the row opens onto one row or
 *  none. queue_resize does not dislodge it; measuring the content
 *  ourselves does.
 *
 *  That measurement is driven by `open` alone, so no call site has to
 *  know any of the above: by the time a row is opened the For has long
 *  since appended, and a list built already-open is caught by the idle
 *  pass. `contents` is a refinement, not a requirement — it covers a
 *  list that changes WHILE the row is open, like the port list after a
 *  pactl refresh. A discriminated union was tried first and does not
 *  survive the JSX layer: gnim maps component props through Omit, which
 *  collapses a union to its common keys, so the requirement vanished at
 *  exactly the call sites that needed it. */
function ExpandList({
    open,
    children,
    scroll = true,
    contents,
}: {
    open: Accessor<boolean>
    children: Gtk.Widget
    /** cap the list and scroll inside it */
    scroll?: boolean
    /** an optional extra trigger, for content that changes while open */
    contents?: Accessor<unknown[]>
}) {
    let sw: Gtk.ScrolledWindow | null = null
    const remeasure = () => {
        if (!sw) return
        const [, nat] = children.measure(Gtk.Orientation.VERTICAL, -1)
        sw.minContentHeight = Math.min(EXPAND_CAP, nat)
    }
    if (scroll) {
        // a row built already-open never fires the open subscription
        let first: number | null = idleAdd("audio:expandList", GLib.PRIORITY_DEFAULT_IDLE, () => {
            first = null
            remeasure()
            return GLib.SOURCE_REMOVE
        })
        onCleanup(open.subscribe(remeasure))
        if (contents) onCleanup(contents.subscribe(remeasure))
        // a row destroyed before the idle runs (the pane rebuilds on
        // every device change) must not measure a dead widget
        onCleanup(() => {
            if (first !== null) sourceRemove(first)
        })
    }
    return (
        <revealer revealChild={open}>
            {scroll ? (
                <Gtk.ScrolledWindow
                    $={self => {
                        sw = self
                    }}
                    cssClasses={["audioExpandList"]}
                    vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
                    hscrollbarPolicy={Gtk.PolicyType.NEVER}
                    maxContentHeight={EXPAND_CAP}
                >
                    {children}
                </Gtk.ScrolledWindow>
            ) : (
                <box orientation={Gtk.Orientation.VERTICAL} cssClasses={["audioExpandList"]}>
                    {children}
                </box>
            )}
        </revealer>
    )
}

/** one playing application: volume, mute, and where its sound goes.
 *  The routing list is collapsed by default — it is the rarer action,
 *  and a sink list under every app would bury the volumes */
function AppRow({
    stream,
    speakers,
    direction,
    open,
    toggle,
}: {
    stream: AstalWp.Stream
    speakers: Accessor<AstalWp.Endpoint[]>
    direction: "output" | "input"
    open: Accessor<boolean>
    toggle: () => void
}) {
    const target = createBinding(stream, "targetEndpoint")
    // "auto" is not a failure to choose: it means the stream follows
    // whatever the default device is, which is what most apps want
    const targetLabel = createComputed([target, speakers], (t, list) => {
        if (t) return t.description || t.name
        const fallback = list.find(s => s.isDefault)
        return fallback
            ? `Follows default · ${fallback.description || fallback.name}`
            : "Follows default"
    })

    return (
        <box orientation={Gtk.Orientation.VERTICAL}>
            <box cssClasses={["paneRow", "audioRow"]} spacing={9}>
                <image
                    iconName={
                        resolveIcon(stream.description || stream.name) ?? "audio-x-generic-symbolic"
                    }
                    pixelSize={16}
                />
                <box orientation={Gtk.Orientation.VERTICAL} hexpand>
                    {/* the name line toggles routing; the slider below
                    keeps its own drag, which a row-wide gesture would
                    steal */}
                    <box hexpand>
                        <Gtk.GestureClick button={1} onPressed={toggle} />
                        <label
                            cssClasses={["paneRowName"]}
                            label={stream.description || stream.name}
                            tooltipText={stream.description || stream.name}
                            xalign={0}
                            hexpand
                            maxWidthChars={22}
                            ellipsize={Pango.EllipsizeMode.END}
                        />
                    </box>
                </box>
                <MuteButton node={stream} />
                <box
                    cssName="button"
                    cssClasses={["audioRoute"]}
                    tooltipText={targetLabel.as(t => `Output: ${t}`)}
                >
                    <Gtk.GestureClick button={1} onPressed={toggle} />
                    <image
                        iconName={open.as(o =>
                            o ? "pan-up-symbolic" : "media-playlist-shuffle-symbolic",
                        )}
                    />
                </box>
            </box>
            {/* the slider spans the row: sharing a line with the icon,
            the mute button and the routing chevron left it barely wide
            enough to aim with */}
            <box cssClasses={["audioSliderRow"]}>
                <VolumeRow
                    value={createBinding(stream, "volume")}
                    onChange={v => (stream.volume = v)}
                />
            </box>
            <ExpandList open={open} contents={speakers}>
                <box orientation={Gtk.Orientation.VERTICAL} cssClasses={["audioRouteList"]}>
                    <label
                        cssClasses={["paneSection"]}
                        xalign={0}
                        label={direction === "output" ? "Send this app to" : "Record this app from"}
                    />
                    <box
                        cssName="button"
                        cssClasses={target.as(t => ["paneRow", ...(t ? [] : ["active"])])}
                    >
                        <Gtk.GestureClick
                            button={1}
                            onPressed={() => {
                                stream.targetEndpoint = null
                                toggle()
                            }}
                        />
                        <label
                            cssClasses={["paneRowName"]}
                            label={"Follow default device"}
                            xalign={0}
                        />
                    </box>
                    <For each={speakers}>
                        {ep => (
                            <box
                                cssName="button"
                                cssClasses={target.as(t => [
                                    "paneRow",
                                    ...(t?.id === ep.id ? ["active"] : []),
                                ])}
                            >
                                <Gtk.GestureClick
                                    button={1}
                                    onPressed={() => {
                                        stream.targetEndpoint = ep
                                        toggle()
                                    }}
                                />
                                <label
                                    cssClasses={["paneRowName"]}
                                    label={ep.description || ep.name}
                                    tooltipText={ep.description || ep.name}
                                    xalign={0}
                                    hexpand
                                    maxWidthChars={30}
                                    ellipsize={Pango.EllipsizeMode.END}
                                />
                            </box>
                        )}
                    </For>
                </box>
            </ExpandList>
        </box>
    )
}

/** an output or input device: volume, mute, and one click to make it
 *  the default */
function DeviceRow({
    endpoint,
    role,
    open,
    toggle,
    meter,
}: {
    endpoint: AstalWp.Endpoint
    role: "output" | "input"
    open: Accessor<boolean>
    toggle: () => void
    /** the sink level, when one is being metered. It belongs to
     *  whichever device is default, so the bar follows the default
     *  rather than being fixed to the row it started on */
    meter?: Accessor<number>
}) {
    const isDefault = createBinding(endpoint, "isDefault")
    // ports come from pactl rather than astal: set_route() does nothing
    // and get_routes() describes the card, not this sink (see
    // lib/audioPorts). Only worth showing when there is a choice, so a
    // laptop with an empty headphone jack gets no chevron
    const portInfo = audioPorts.as(m => m.get(endpoint.serial) ?? null)
    const routes = portInfo.as(i => i?.ports ?? [])
    const activePort = portInfo.as(i => i?.active ?? null)
    const portLabel = createComputed([portInfo, activePort], (info, active) => {
        const port = info?.ports.find(x => x.name === active)
        return port?.description ?? (role === "input" ? "Microphone" : "Output")
    })
    return (
        <box orientation={Gtk.Orientation.VERTICAL}>
            <box
                cssClasses={isDefault.as(d => ["paneRow", "audioRow", ...(d ? ["active"] : [])])}
                spacing={9}
            >
                {/* the whole row makes it default; the controls in it do not */}
                <Gtk.GestureClick
                    button={1}
                    onPressed={() => {
                        // astal's set_is_default does not switch the default
                        execAsync(["wpctl", "set-default", endpoint.id.toString()]).catch(e =>
                            console.warn("audio: set-default failed:", e),
                        )
                    }}
                />
                <image
                    iconName={createBinding(endpoint, "icon").as(n => audioIcon(n, role))}
                    pixelSize={16}
                />
                <box orientation={Gtk.Orientation.VERTICAL} hexpand>
                    <box spacing={6}>
                        <label
                            cssClasses={["paneRowName"]}
                            label={endpoint.description || endpoint.name}
                            tooltipText={endpoint.description || endpoint.name}
                            xalign={0}
                            hexpand
                            maxWidthChars={26}
                            ellipsize={Pango.EllipsizeMode.END}
                        />
                        <label
                            cssClasses={["audioDefaultTag"]}
                            label={"default"}
                            visible={isDefault}
                        />
                    </box>
                    {/* the port, which is the only thing that tells one of
                    these rows from the other: a card's sink and source
                    carry the SAME description ("… Analog Stereo"), so
                    output and input read identically without it. Bound,
                    not read once: plugging headphones in changes it */}
                    <label
                        cssClasses={["paneRowDesc"]}
                        label={portLabel}
                        tooltipText={portLabel}
                        xalign={0}
                        maxWidthChars={28}
                        ellipsize={Pango.EllipsizeMode.END}
                    />
                </box>
                <box
                    cssClasses={["audioRoute"]}
                    tooltipText={"Change port"}
                    visible={routes.as(r => r.length > 1)}
                >
                    <Gtk.GestureClick button={1} onPressed={toggle} />
                    <image iconName={open.as(o => (o ? "pan-up-symbolic" : "pan-down-symbolic"))} />
                </box>
                <MuteButton node={endpoint} />
            </box>
            {/* the slider spans the row rather than sharing a line with
            the icon and the mute button: at ~380px a 0-150% range is
            aimable */}
            <box cssClasses={["audioSliderRow"]}>
                <VolumeRow
                    value={createBinding(endpoint, "volume")}
                    onChange={v => endpoint.set_volume(v)}
                    meter={
                        meter && {
                            level: meter,
                            visible: isDefault,
                        }
                    }
                />
            </box>
            <ExpandList open={open} scroll={false}>
                <box orientation={Gtk.Orientation.VERTICAL} cssClasses={["audioRouteList"]}>
                    <label
                        cssClasses={["paneSection"]}
                        xalign={0}
                        label={role === "input" ? "Take input from" : "Send output to"}
                    />
                    <For each={routes}>
                        {port => (
                            <box
                                cssName="button"
                                cssClasses={activePort.as(active => [
                                    "paneRow",
                                    ...(active === port.name ? ["active"] : []),
                                ])}
                            >
                                <Gtk.GestureClick
                                    button={1}
                                    onPressed={() => {
                                        setPort(endpoint.serial, role, port.name)
                                        toggle()
                                    }}
                                />
                                <label
                                    cssClasses={["paneRowName"]}
                                    label={port.description}
                                    tooltipText={port.description}
                                    xalign={0}
                                    hexpand
                                    maxWidthChars={30}
                                    ellipsize={Pango.EllipsizeMode.END}
                                />
                            </box>
                        )}
                    </For>
                </box>
            </ExpandList>
        </box>
    )
}

function CardRow({
    device,
    open,
    toggle,
}: {
    device: AstalWp.Device
    open: Accessor<boolean>
    toggle: () => void
}) {
    const profiles = createBinding(device, "profiles").as(p => p ?? [])
    const activeId = createBinding(device, "activeProfileId")
    const activeLabel = createComputed([profiles, activeId], (list, id) => {
        const match = list.find(p => p.index === id)
        return match ? match.description : "—"
    })

    return (
        <box orientation={Gtk.Orientation.VERTICAL}>
            <box cssClasses={["paneRow", "audioRow"]} spacing={9}>
                {/* the whole row is the target: a 16px chevron is a mean
                thing to ask anyone to hit */}
                <Gtk.GestureClick button={1} onPressed={toggle} />
                <image
                    iconName={createBinding(device, "icon").as(n => audioIcon(n, "card"))}
                    pixelSize={16}
                />
                <box orientation={Gtk.Orientation.VERTICAL} hexpand>
                    <label
                        cssClasses={["paneRowName"]}
                        label={device.description || `Card ${device.id}`}
                        tooltipText={device.description || `Card ${device.id}`}
                        xalign={0}
                        maxWidthChars={26}
                        ellipsize={Pango.EllipsizeMode.END}
                    />
                    <label
                        cssClasses={["paneRowDesc"]}
                        label={activeLabel}
                        tooltipText={activeLabel}
                        xalign={0}
                        maxWidthChars={30}
                        ellipsize={Pango.EllipsizeMode.END}
                    />
                </box>
                <box cssClasses={["audioRoute"]} tooltipText={"Change profile"}>
                    <image iconName={open.as(o => (o ? "pan-up-symbolic" : "pan-down-symbolic"))} />
                </box>
            </box>
            <ExpandList open={open} contents={profiles}>
                <box orientation={Gtk.Orientation.VERTICAL} cssClasses={["audioRouteList"]}>
                    <For each={profiles}>
                        {profile => (
                            <box
                                cssName="button"
                                cssClasses={activeId.as(id => [
                                    "paneRow",
                                    ...(id === profile.index ? ["active"] : []),
                                ])}
                            >
                                <Gtk.GestureClick
                                    button={1}
                                    onPressed={() => {
                                        device.activeProfileId = profile.index
                                        toggle()
                                    }}
                                />
                                <label
                                    cssClasses={["paneRowName"]}
                                    label={profile.description}
                                    tooltipText={profile.description}
                                    xalign={0}
                                    hexpand
                                    maxWidthChars={30}
                                    ellipsize={Pango.EllipsizeMode.END}
                                />
                            </box>
                        )}
                    </For>
                </box>
            </ExpandList>
        </box>
    )
}

function Section({ title, empty }: { title: string; empty?: string }) {
    return <label cssClasses={["paneSection"]} xalign={0} label={empty ?? title} />
}

/** One pane per direction, never both in one list: an output pane and
 *  an input pane share widget code but nothing else. The card's sink
 *  and source carry the SAME description, so a combined list showed two
 *  rows that read identically and only differed by their port.
 *  @param direction which half of the audio graph this pane owns */
export function AudioPane({
    direction,
    pane,
    name,
}: {
    direction: "output" | "input"
    pane: Accessor<string>
    name: string
}) {
    const wp = audio()
    if (!wp) return <label cssClasses={["paneEmpty"]} label={"No audio server"} />

    // one row unfolded at a time: two open lists stacked on top of each
    // other made it impossible to tell which options belonged to which
    // card, and pushed the second row off the pane
    const [openRow, setOpenRow] = createState<string | null>(null)
    const rowState = (key: string) => ({
        open: openRow.as(o => o === key),
        toggle: () => setOpenRow(openRow.get() === key ? null : key),
    })

    const isOutput = direction === "output"

    // the level bar costs a capture client, so it exists only while this
    // pane is the one on screen — the same rule the stats tiles follow.
    // The input meter genuinely opens the microphone, so it answers to
    // its own config key: someone may well want to see what is coming
    // out without the shell listening to the room
    const meter = isOutput ? outputMeter : inputMeter
    const metered =
        meterSupported &&
        (isOutput ? Config.quicksettings.audioMeter : Config.quicksettings.micMeter)
    let release: (() => void) | null = null
    const sync = () => {
        const onScreen = qsVisible.get() && pane.get() === name
        if (onScreen) {
            // ports change with the hardware, not on a timer: a jack
            // gains a port when something is plugged into it, so re-read
            // whenever the pane comes up rather than polling pactl. This
            // is outside the meter check on purpose — the port list is
            // not part of that bargain
            refreshPorts()
            if (metered && !release) release = meter.acquire()
        } else if (release) {
            release()
            release = null
        }
    }
    const unsubs = [pane.subscribe(sync), qsVisible.subscribe(sync)]
    onCleanup(() => {
        unsubs.forEach(u => u())
        release?.()
        release = null
    })

    // the endpoints this pane configures, and the app streams that feed
    // them — a playback stream can only be routed to a sink, a
    // recording stream only to a source
    const endpoints = createBinding(wp, isOutput ? "speakers" : "microphones").as(e => e ?? [])
    // our own level meter reads the sink's monitor, which makes it a
    // recording stream like any other. Listing it would tell the user
    // the shell is recording them, when it is reading a bar they are
    // currently looking at
    const appStreams = createBinding(wp, isOutput ? "streams" : "recorders").as(s =>
        (s ?? []).filter(x => !`${x.name ?? ""} ${x.description ?? ""}`.includes(METER_CLIENT)),
    )
    // cards appear in both panes: changing a profile is how an output
    // or an input is enabled in the first place (a card set to "Analog
    // Stereo Output" has no source at all)
    const cards = createBinding(wp, "devices").as(d =>
        (d ?? []).filter(x => (x.profiles ?? []).length > 1),
    )

    return (
        <box orientation={Gtk.Orientation.VERTICAL} cssClasses={["paneCard", "audioPane"]}>
            {/* every section is its own box: a For fills in late (the
                lists resolve after construction), so rows appended to a
                shared parent land after ALL the static labels — which
                put every heading at the top and the content beneath in
                arrival order */}
            <box orientation={Gtk.Orientation.VERTICAL}>
                <Section title={isOutput ? "Playing" : "Recording"} />
                <label
                    cssClasses={["paneRowDesc"]}
                    xalign={0}
                    label={isOutput ? "Nothing is playing" : "Nothing is recording"}
                    visible={appStreams.as(s => s.length === 0)}
                />
                <For each={appStreams}>
                    {s => (
                        <AppRow
                            stream={s}
                            speakers={endpoints}
                            direction={direction}
                            {...rowState(`app:${s.id}`)}
                        />
                    )}
                </For>
            </box>

            <box orientation={Gtk.Orientation.VERTICAL}>
                <Section title={isOutput ? "Output devices" : "Input devices"} />
                <For each={endpoints}>
                    {ep => (
                        <DeviceRow
                            endpoint={ep}
                            role={direction}
                            meter={metered ? meter.level : undefined}
                            {...rowState(`port:${ep.id}`)}
                        />
                    )}
                </For>
            </box>

            <box orientation={Gtk.Orientation.VERTICAL} visible={cards.as(c => c.length > 0)}>
                <Section title="Cards" />
                <For each={cards}>{d => <CardRow device={d} {...rowState(`card:${d.id}`)} />}</For>
            </box>
        </box>
    )
}
