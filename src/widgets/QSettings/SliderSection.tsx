import AstalWp from "gi://AstalWp?version=0.1";
import Gtk from "gi://Gtk?version=4.0";
import GLib from "gi://GLib?version=2.0";
import Pango from "gi://Pango?version=1.0";
import { execAsync } from "ags/process";
import Config from "../../config";
import Brightness from "../../lib/brightness";
import hyprsunset, { setOutdoorEnabled, OUTDOOR_GAMMA } from "../../lib/hyprsunset";
import { Accessor, For, Setter, With, createBinding, createComputed, createState } from "gnim";

interface VolSliderProps {
    maxValue?: number
    endpoint: AstalWp.Endpoint
    expanded: Accessor<number>
    setExpanded: Setter<number>
    dropdownIndex: number
}

function DeviceList({ endpoints, collapse }: {
    endpoints: Accessor<AstalWp.Endpoint[]>
    collapse: () => void
}) {
    return <box orientation={Gtk.Orientation.VERTICAL}>
        <For each={endpoints}>
            {(ep) => (
                <box
                    cssName={"button"}
                    cssClasses={createBinding(ep, "isDefault").as(d => d ? ["active"] : [])}
                >
                    <Gtk.GestureClick
                        button={1}
                        onPressed={() => {
                            // astal's set_is_default doesn't switch the
                            // default, wpctl does
                            execAsync(["wpctl", "set-default", ep.id.toString()])
                                .catch((e) => console.error(e))
                            collapse()
                        }}
                    />
                    <label
                        label={ep.description || ep.name}
                        xalign={0}
                        maxWidthChars={30}
                        ellipsize={Pango.EllipsizeMode.END}
                    />
                </box>
            )}
        </For>
    </box>
}

function VolSlider({
    maxValue: maxValue = 1.5,
    endpoint: endpoint,
    expanded: expanded,
    setExpanded: setExpanded,
    dropdownIndex: dropdownIndex
}: VolSliderProps) {
    const volume = createBinding(endpoint, "volume")
    const deviceName = (
        <label
            canTarget={false}
            cssClasses={["deviceName"]}
            halign={Gtk.Align.START}
            valign={Gtk.Align.CENTER}
            maxWidthChars={24}
            ellipsize={Pango.EllipsizeMode.END}
            label={createBinding(endpoint, "description")
                .as(d => d || endpoint.name || "")}
        />) as Gtk.Label
    // Drag damping: the slider itself is non-interactive (canTarget=false),
    // a GestureDrag drives it instead. Press warps the knob to the press
    // position (click-to-position), then pointer movement applies at
    // DAMP_FACTOR speed so the knob deliberately trails the pointer —
    // no fighting with GTK's own drag handling.
    const DAMP_FACTOR = 0.3
    let dragStartVol = 0
    let dragWidth = 260
    return <box
        cssClasses={volume.as((v) => {
            if (v > 1.01)
                return ["sliderRow", "volHigh"]
            return ["sliderRow"]
        })}
    >
        <button>
            <Gtk.EventControllerScroll
                flags={Gtk.EventControllerScrollFlags.VERTICAL}
                onScroll={(
                    source: Gtk.EventControllerScroll,
                    arg0: number,
                    arg1: number
                ) => {
                    endpoint.volume -= arg1 / 100;
                    return true;
                }} />
            <Gtk.GestureClick
                button={1}
                onPressed={() => {
                    endpoint.mute = !endpoint.mute;
                    return true;
                }} />
            <image iconName={createBinding(endpoint, "volumeIcon")} />
        </button>
        <overlay $={(self) => {
            if (Config.quicksettings.showDeviceNames)
                self.add_overlay(deviceName)
        }}>
            <Gtk.GestureDrag
                button={1}
                onDragBegin={(gesture, x) => {
                    dragWidth = gesture.get_widget()?.get_width() ?? 260
                    dragStartVol = Math.min(Math.max(
                        (x / dragWidth) * maxValue, 0), maxValue)
                    endpoint.set_volume(dragStartVol)
                }}
                onDragUpdate={(_gesture, dx) => {
                    const dv = (dx / dragWidth) * maxValue * DAMP_FACTOR
                    endpoint.set_volume(Math.min(Math.max(
                        dragStartVol + dv, 0), maxValue))
                }}
            />
            <Gtk.EventControllerScroll
                flags={Gtk.EventControllerScrollFlags.VERTICAL}
                onScroll={(_source, _dx, dy) => {
                    endpoint.volume -= dy / 100
                    return true
                }}
            />
            <slider
                canTarget={false}
                hexpand
                max={maxValue}
                widthRequest={260}
                value={volume} />
        </overlay>
        <label
            widthChars={5}
            maxWidthChars={5}
            label={volume.as((v) => `${Math.floor(v * 100)}%`)} />
        <box cssName="button" tooltipText={"Change device"}>
            <Gtk.GestureClick
                button={1}
                onPressed={() => {
                    setExpanded(expanded.get() === dropdownIndex ? 0 : dropdownIndex)
                }} />
            <image iconName={expanded.as(v => v === dropdownIndex ? "pan-up-symbolic" : "pan-down-symbolic")} />
        </box>
    </box>

}

function BrightnessSlider() {
    const brightness = Brightness.get_default()
    if (!brightness.screenIsPresent)
        return <></>

    const screen = createBinding(brightness, "screen")

    // slowly rotate the icon while outdoor mode is on, like day rolling in
    const [angle, setAngle] = createState(0)
    let spinSource: number | null = null
    hyprsunset.outdoor.subscribe(() => {
        if (hyprsunset.outdoor.get()) {
            if (spinSource !== null) return
            spinSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                setAngle(a => (a + 6) % 360)
                return GLib.SOURCE_CONTINUE
            })
        } else {
            if (spinSource !== null) {
                GLib.source_remove(spinSource)
                spinSource = null
            }
            setAngle(0)
        }
    })

    let scrollAcc = 0
    return <box cssClasses={hyprsunset.outdoor.as(v => v ? ["sliderRow", "overdrive"] : ["sliderRow"])}>
        <box cssName="button" tooltipText={"Click: reset to 100%, scroll: outdoor mode"}>
            <Gtk.GestureClick
                button={1}
                onPressed={() => { brightness.screen = 1 }} />
            <Gtk.EventControllerScroll
                flags={Gtk.EventControllerScrollFlags.VERTICAL}
                onScroll={(_s, _dx, dy) => {
                    setOutdoorEnabled(dy < 0)
                    return true
                }} />
            <image
                iconName={"display-brightness-symbolic"}
                css={angle.as(a => `transform: rotate(${a}deg);`)}
            />
        </box>
        <slider
            hexpand
            min={0}
            max={1}
            widthRequest={260}
            onChangeValue={({ value }) => { brightness.screen = value }}
            value={screen}>
            <Gtk.EventControllerScroll
                flags={Gtk.EventControllerScrollFlags.VERTICAL}
                onScroll={(_s, _dx, dy) => {
                    // accumulate deltas and step 1% per 5 units:
                    // device-independent speed (touchpads emit many
                    // small deltas, wheels few big ones)
                    scrollAcc += dy
                    const steps = Math.trunc(scrollAcc / 5)
                    if (steps !== 0) {
                        scrollAcc -= steps * 5
                        // setDimLevel exits outdoor mode, so scrolling
                        // always lands on the bar
                        brightness.screen = Math.min(1,
                            Math.max(0.05, brightness.screen - steps / 100))
                    }
                    return true
                }} />
        </slider>
        <label
            widthChars={5}
            maxWidthChars={5}
            label={createComputed(
                [hyprsunset.outdoor, screen],
                // show the effective gamma: outdoor boost or slider value
                (outdoor, v) => outdoor ? `${OUTDOOR_GAMMA}%` : `${Math.floor(v * 100)}%`
            )} />
    </box>
}

export function SliderSection() {
    const wp = AstalWp.get_default()!
    const { audio } = wp

    const [expanded, setExpanded] = createState(0)

    const speakers = createBinding(audio, "speakers").as(s => s ?? [])
    const microphones = createBinding(audio, "microphones").as(m => m ?? [])

    return <box cssClasses={["QSSection"]} orientation={Gtk.Orientation.VERTICAL}>
        <With value={createBinding(wp, "defaultSpeaker")}>
            {(speaker) => speaker &&
                <VolSlider
                    endpoint={speaker}
                    expanded={expanded}
                    setExpanded={setExpanded}
                    dropdownIndex={1} />}
        </With>
        <revealer revealChild={expanded.as(v => v === 1)}>
            <DeviceList endpoints={speakers} collapse={() => setExpanded(0)} />
        </revealer>
        <With value={createBinding(wp, "defaultMicrophone")}>
            {(microphone) => microphone &&
                <VolSlider
                    endpoint={microphone}
                    maxValue={1}
                    expanded={expanded}
                    setExpanded={setExpanded}
                    dropdownIndex={2} />}
        </With>
        <revealer revealChild={expanded.as(v => v === 2)}>
            <DeviceList endpoints={microphones} collapse={() => setExpanded(0)} />
        </revealer>
        <BrightnessSlider />
    </box>;
}
