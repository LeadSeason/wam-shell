import { Gtk } from "ags/gtk4"
import AstalWp from "gi://AstalWp?version=0.1"
import { createBinding } from "gnim"

// @TODO, this will be put in the powermenu... Later

export function AudioOutput() {
    const { defaultSpeaker: speaker } = AstalWp.get_default()!

    return (
        <menubutton
        >
            <Gtk.EventControllerScroll
                flags={Gtk.EventControllerScrollFlags.VERTICAL}
                onScroll={(
                    source: Gtk.EventControllerScroll,
                    arg0: number,
                    arg1: number
                ) => {
                    speaker.volume -= arg1 / 100
                    return true
                }}
            />
            <Gtk.GestureClick
                button={3}
                onPressed={() => {
                    speaker.mute = !speaker.mute
                    return true
                }}
            />
            <box spacing={6}>
                <label 
                    class={createBinding(speaker, "mute").as((v) => v ? "muted" : "")}
                    label={createBinding(speaker, "volume").as((v: number) => (v * 100).toFixed(0) + "%")} 
                    />
                <image iconName={createBinding(speaker, "volumeIcon")} />
            </box>
            <popover>
                <box>
                    <slider
                        max={1.5}
                        widthRequest={260}
                        onChangeValue={({ value }) => speaker.set_volume(value)}
                        value={createBinding(speaker, "volume")}
                    />
                </box>
                    
                {/** 
                 * List All devices
                 * Have a button to change the default speaker.
                 * 
                 * List All sources
                 * button to mute a source
                 * 
                 * If possible show to current level of the source
                 *
                 */}
            </popover>
        </menubutton>
    )
}

export function AudioInput() {
    const { defaultMicrophone: microphone } = AstalWp.get_default()!

    return (
        <menubutton
        >
            <Gtk.EventControllerScroll
                flags={Gtk.EventControllerScrollFlags.VERTICAL}
                onScroll={(
                    source: Gtk.EventControllerScroll,
                    arg0: number,
                    arg1: number
                ) => {
                    microphone.volume -= arg1 / 150
                    return true
                }}
            />
            <Gtk.GestureClick
                button={3}
                onPressed={() => {
                    microphone.mute = !microphone.mute
                    return true
                }}
            />
            <box spacing={6}>
                <label
                    class={createBinding(microphone, "mute").as((v) => v ? "muted" : "")}
                    label={createBinding(microphone, "volume").as((v) => (v * 100).toFixed(0) + "%")}
                />
                <image iconName={createBinding(microphone, "volumeIcon")} />
            </box>
            <popover>
                <box>
                    <slider
                        widthRequest={260}
                        onChangeValue={({ value }) => microphone.set_volume(value)}
                        value={createBinding(microphone, "volume")}
                    />
                </box>
            </popover>
        </menubutton>
    )
}