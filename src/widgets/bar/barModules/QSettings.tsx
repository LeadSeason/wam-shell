import { Gtk } from "ags/gtk4"
import AstalWp from "gi://AstalWp?version=0.1"
import { createBinding } from "gnim"

function speakerIcon(): Gtk.MenuButton {
    // reactivity, Scrollable, Right click to mute
    const { defaultSpeaker: speaker } = AstalWp.get_default()!
    return (<menubutton>
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
        <image iconName={createBinding(speaker, "volumeIcon")} />
    </menubutton>) as Gtk.MenuButton // Jank
}


function microphoneIcon(): Gtk.MenuButton {
    // reactivity, Scrollable, Right click to mute
    const { defaultMicrophone: microphone } = AstalWp.get_default()!

    return (<menubutton>
        <Gtk.EventControllerScroll
            flags={Gtk.EventControllerScrollFlags.VERTICAL}
            onScroll={(
                source: Gtk.EventControllerScroll,
                arg0: number,
                arg1: number
            ) => {
                microphone.volume -= arg1 / 100
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
        <image iconName={createBinding(microphone, "volumeIcon")} />
    </menubutton>) as Gtk.MenuButton // Jank
}

function ButtonLabel() {
    // Examples, Wifi, Power profile, Speaker and or microphone volume, Battery.
    // Configurable?
    
    const labelBox = new Gtk.Box()
    labelBox.spacing = 7
    
    // @TODO Configuration check speaker
    if (true) {
        labelBox.append(speakerIcon())
    }
    // @TODO Configuration check Microphone
    if (true) {
        labelBox.append(microphoneIcon())
    }

    return labelBox
}


export default function QSettings() {
    return <menubutton
        cssClasses={["QSettings"]}
    >
        <Gtk.GestureClick
            button={1}
            onPressed={() => {
                // Show window
                print("Implement Show window")
            }}
        />
        <ButtonLabel />
    </menubutton>;
}
