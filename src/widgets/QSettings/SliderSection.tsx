import AstalWp from "gi://AstalWp?version=0.1";
import Gtk from "gi://Gtk?version=4.0";
import { createBinding } from "gnim";

export function SliderSection() {
    const { defaultSpeaker: speaker } = AstalWp.get_default()!;
    const { defaultMicrophone: microphone } = AstalWp.get_default()!;

    return <box cssClasses={["QSSection"]} orientation={Gtk.Orientation.VERTICAL}>
        <box>
            <button>
                <Gtk.EventControllerScroll
                    flags={Gtk.EventControllerScrollFlags.VERTICAL}
                    onScroll={(
                        source: Gtk.EventControllerScroll,
                        arg0: number,
                        arg1: number
                    ) => {
                        speaker.volume -= arg1 / 100;
                        return true;
                    }} />
                <Gtk.GestureClick
                    button={1}
                    onPressed={() => {
                        speaker.mute = !speaker.mute;
                        return true;
                    }} />
                <image iconName={createBinding(speaker, "volumeIcon")} />
            </button>
            <slider
                max={1.5}
                widthRequest={260}
                onChangeValue={({ value }) => speaker.set_volume(value)}
                value={createBinding(speaker, "volume")} />
        </box>

        <box>
            <button> /* This is used so 4 times in QSettings. Should
                be probably made in to a function */ /* This is used so 4 times in QSettings. Should
                be probably made in to a function */
                <Gtk.EventControllerScroll
                    flags={Gtk.EventControllerScrollFlags.VERTICAL}
                    onScroll={(
                        source: Gtk.EventControllerScroll,
                        arg0: number,
                        arg1: number
                    ) => {
                        microphone.volume -= arg1 / 100;
                        return true;
                    }} />
                <Gtk.GestureClick
                    button={1}
                    onPressed={() => {
                        microphone.mute = !microphone.mute;
                        return true;
                    }} />
                <image iconName={createBinding(microphone, "volumeIcon")} />
            </button>
            <slider
                widthRequest={260}
                onChangeValue={({ value }) => microphone.set_volume(value)}
                value={createBinding(microphone, "volume")} />
        </box>
    </box>;
}
