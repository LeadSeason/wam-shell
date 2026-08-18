import AstalWp from "gi://AstalWp?version=0.1"
import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango?version=1.0"
import Config from "../../config"
import Brightness from "../../lib/brightness"
import hyprsunset, { setOutdoorEnabled, OUTDOOR_GAMMA } from "../../lib/hyprsunset"
import { scrollDelta } from "../../lib/scrollStep"
import { watchDefaultEndpoint } from "../../lib/defaultEndpoint"
import { With, createBinding, createComputed, createState, onCleanup } from "gnim"
import { PercentEntry } from "./PercentEntry"
import { pressable } from "../pressable"

interface VolSliderProps {
    maxValue?: number
    endpoint: AstalWp.Endpoint
    /** the chevron opens the audio pane, which owns devices, app
     *  volumes, routing and card profiles */
    onOpen: () => void
}

function VolSlider({
    maxValue: maxValue = 1.5,
    endpoint: endpoint,
    onOpen: onOpen,
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
            label={createBinding(endpoint, "description").as(d => d || endpoint.name || "")}
        />
    ) as Gtk.Label
    // Drag damping: the slider itself is non-interactive (canTarget=false),
    // a GestureDrag drives it instead. Press warps the knob to the press
    // position (click-to-position), then pointer movement applies at
    // DAMP_FACTOR speed so the knob deliberately trails the pointer —
    // no fighting with GTK's own drag handling.
    const DAMP_FACTOR = 0.3
    let dragStartVol = 0
    let dragWidth = 260
    return (
        <box
            cssClasses={volume.as(v => {
                if (v > 1.01) return ["sliderRow", "volHigh"]
                return ["sliderRow"]
            })}
        >
            <button>
                <Gtk.EventControllerScroll
                    flags={Gtk.EventControllerScrollFlags.VERTICAL}
                    onScroll={(controller: Gtk.EventControllerScroll, _dx: number, dy: number) => {
                        // pipewire reports negative volume when scrolled
                        // past zero, which breaks css and the OSD; clamp the
                        // top like the drag path does
                        endpoint.volume = Math.min(
                            maxValue,
                            Math.max(0, endpoint.volume + scrollDelta(controller, dy, 0.02)),
                        )
                        return true
                    }}
                />
                <Gtk.GestureClick
                    button={1}
                    onPressed={() => {
                        endpoint.mute = !endpoint.mute
                        return true
                    }}
                />
                <image iconName={createBinding(endpoint, "volumeIcon")} />
            </button>
            <overlay
                $={self => {
                    if (Config.quicksettings.showDeviceNames) self.add_overlay(deviceName)
                }}
            >
                <Gtk.GestureDrag
                    button={1}
                    onDragBegin={(gesture, x) => {
                        dragWidth = gesture.get_widget()?.get_width() ?? 260
                        dragStartVol = Math.min(Math.max((x / dragWidth) * maxValue, 0), maxValue)
                        endpoint.set_volume(dragStartVol)
                    }}
                    onDragUpdate={(_gesture, dx) => {
                        const dv = (dx / dragWidth) * maxValue * DAMP_FACTOR
                        endpoint.set_volume(Math.min(Math.max(dragStartVol + dv, 0), maxValue))
                    }}
                />
                <Gtk.EventControllerScroll
                    flags={Gtk.EventControllerScrollFlags.VERTICAL}
                    onScroll={(controller, _dx, dy) => {
                        endpoint.volume = Math.min(
                            maxValue,
                            Math.max(0, endpoint.volume + scrollDelta(controller, dy, 0.02)),
                        )
                        return true
                    }}
                />
                <slider
                    canTarget={false}
                    hexpand
                    max={maxValue}
                    widthRequest={260}
                    value={volume}
                />
            </overlay>
            <PercentEntry value={volume} onCommit={v => endpoint.set_volume(v)} max={maxValue} />
            <box cssName="button" tooltipText={"Devices, app volumes and routing"}>
                <Gtk.GestureClick button={1} {...pressable(onOpen)} />
                <image iconName={"go-next-symbolic"} />
            </box>
        </box>
    )
}

function BrightnessSlider() {
    const brightness = Brightness.get_default()
    if (!brightness.screenIsPresent) return <></>

    const screen = createBinding(brightness, "screen")

    const previous = createBinding(brightness, "previous")
    return (
        <box
            cssClasses={hyprsunset.outdoor.as(v =>
                v ? ["sliderRow", "overdrive"] : ["sliderRow"],
            )}
        >
            <box cssName="button" tooltipText={"Click: reset to 100%, scroll: outdoor mode"}>
                <Gtk.GestureClick
                    button={1}
                    {...pressable(() => {
                        brightness.screen = 1
                    })}
                />
                <Gtk.EventControllerScroll
                    flags={Gtk.EventControllerScrollFlags.VERTICAL}
                    onScroll={(_s, _dx, dy) => {
                        setOutdoorEnabled(dy < 0)
                        return true
                    }}
                />
                <image
                    iconName={"display-brightness-symbolic"}
                    // spin while outdoor mode is on via a CSS animation
                    // (.overdrive .brightnessSpin) instead of a 50ms JS timer
                    cssClasses={["brightnessSpin"]}
                />
            </box>
            <slider
                hexpand
                min={0}
                max={1}
                widthRequest={260}
                onChangeValue={({ value }) => {
                    brightness.screen = value
                }}
                value={screen}
            >
                <Gtk.EventControllerScroll
                    flags={Gtk.EventControllerScrollFlags.VERTICAL}
                    onScroll={(controller, _dx, dy) => {
                        // unit-aware step is shared (lib/scrollStep).
                        // setDimLevel exits outdoor mode, so scrolling
                        // always lands on the bar
                        brightness.screen = Math.min(
                            1,
                            Math.max(0.05, brightness.screen + scrollDelta(controller, dy, 0.02)),
                        )
                        return true
                    }}
                />
            </slider>
            <label
                widthChars={5}
                maxWidthChars={5}
                label={createComputed(
                    [hyprsunset.outdoor, screen],
                    // show the effective gamma: outdoor boost or slider value
                    (outdoor, v) => (outdoor ? `${OUTDOOR_GAMMA}%` : `${Math.floor(v * 100)}%`),
                )}
            />
            {/* undo the last change (any source: slider, scroll, keybinds,
            sleep-timer dim); toggles between the two levels. Always
            visible, dimmed/inert until a value has been recorded */}
            <box
                cssName="button"
                cssClasses={previous.as(p => ["brightnessRestore", ...(p < 0 ? ["disabled"] : [])])}
                tooltipText={previous.as(p =>
                    p < 0
                        ? "Nothing to restore yet"
                        : `Restore previous brightness (${Math.round(p * 100)}%)`,
                )}
            >
                <Gtk.GestureClick
                    button={1}
                    {...pressable(() => {
                        if (previous.get() >= 0) brightness.restorePrevious()
                    })}
                />
                <image iconName={"edit-undo-symbolic"} />
            </box>
        </box>
    )
}

export function SliderSection({ navigate }: { navigate: (pane: string) => void }) {
    const wp = AstalWp.get_default()

    // wireplumber absent or audio not connected: brightness still works
    if (!wp || !wp.audio)
        return (
            <box cssClasses={["paneCard"]} orientation={Gtk.Orientation.VERTICAL}>
                <BrightnessSlider />
            </box>
        )
    const { audio } = wp

    // the current default endpoint comes from the real node list, NOT
    // wp.defaultSpeaker — that proxy can keep a dead node after device
    // re-enumeration (and never notifies), leaving the slider writing
    // volume to a device that no longer exists. Why: lib/defaultEndpoint.ts
    function trackDefault(prop: "speakers" | "microphones") {
        const [endpoint, setEndpoint] = createState<AstalWp.Endpoint | null>(null)
        onCleanup(watchDefaultEndpoint(audio, prop, setEndpoint))
        return endpoint
    }

    // the tracker re-resolves on every device switch, and a With rebuild
    // appends at the END of the parent box — the wrapper box holds the
    // slot instead (same pattern as the bar's audioSlot), with `visible`
    // bound so an empty wrapper leaves no hole
    function audioSlot(prop: "speakers" | "microphones", pane: string, maxValue?: number) {
        const endpoint = trackDefault(prop)
        return (
            <box visible={endpoint.as(e => e !== null)}>
                <With value={endpoint}>
                    {e =>
                        e && (
                            <VolSlider
                                endpoint={e}
                                maxValue={maxValue}
                                onOpen={() => navigate(pane)}
                            />
                        )
                    }
                </With>
            </box>
        )
    }

    return (
        // with device names on, the name is drawn INSIDE the trough, and
        // the slim default bar cannot hold a line of text. The whole
        // group opts back into the taller bar rather than just the two
        // sliders carrying names: three rows in one card should be the
        // same height as each other
        <box
            cssClasses={
                Config.quicksettings.showDeviceNames ? ["paneCard", "namedSlider"] : ["paneCard"]
            }
            orientation={Gtk.Orientation.VERTICAL}
        >
            {audioSlot("speakers", "audioOutput")}
            {audioSlot("microphones", "audioInput", 1)}

            <BrightnessSlider />
        </box>
    )
}
