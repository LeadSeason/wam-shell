import AstalWp from "gi://AstalWp?version=0.1";
import Gtk from "gi://Gtk?version=4.0";
import { Accessor, createBinding } from "gnim";

interface VolSliderProps {
    maxValue?: number
    endpoint: AstalWp.Endpoint
}

function VolSlider({
    maxValue: maxValue = 1.5,
    endpoint: endpoint
}: VolSliderProps) {
    const volume = createBinding(endpoint, "volume")
    return <box
        cssClasses={volume.as((v) => {
            if (v > 1 )
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
                label={volume.as((v) => `${Math.floor(v * 100)}%`)}/>
        </box>

}

export function SliderSection() {
    const { defaultSpeaker: speaker } = AstalWp.get_default()!;
    const { defaultMicrophone: microphone } = AstalWp.get_default()!;
    // @TODO, Brightness slider?

    return <box cssClasses={["QSSection"]} orientation={Gtk.Orientation.VERTICAL}>
        <VolSlider endpoint={speaker} />
        <VolSlider endpoint={microphone} maxValue={1}/>
    </box>;
}
