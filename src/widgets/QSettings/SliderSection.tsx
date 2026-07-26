import AstalWp from "gi://AstalWp?version=0.1";
import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango?version=1.0";
import { execAsync } from "ags/process";
import { Accessor, For, Setter, With, createBinding, createState } from "gnim";

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
    return <box
        cssClasses={volume.as((v) => {
            if (v > 1)
                return ["volHigh"]
            return []
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
        <slider
            hexpand
            max={maxValue}
            widthRequest={260}
            onChangeValue={({ value }) => endpoint.set_volume(value)}
            value={volume} />
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

export function SliderSection() {
    const wp = AstalWp.get_default()!
    const { audio } = wp
    // @TODO, Brightness slider?

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
    </box>;
}
