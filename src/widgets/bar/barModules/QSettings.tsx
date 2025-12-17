import { Gtk } from "ags/gtk4"
import { timeout } from "ags/time"
import AstalWp from "gi://AstalWp?version=0.1"
import { createBinding, createState } from "gnim"
import CommandRegistry from "../../../lib/requestHandler"
import { SliderSection } from "../../QSettings/SliderSection"

const registry = CommandRegistry.get_default()

function audioWidget(driver: AstalWp.Endpoint): Gtk.MenuButton {
    // reactivity, Scrollable, Right click to mute
    const [visible, setVisible] = createState<boolean>(false)
    let count = 0
    const show = () => {
        setVisible(true)
        count++
        timeout(750, () => {
            count--
            if (count === 0 && visible.get()) {
                setVisible(false)
            }
        })
    }

    // This show it initially once.
    createBinding(driver, "volume").subscribe(show)

    return (<box>
        <Gtk.EventControllerScroll
            flags={Gtk.EventControllerScrollFlags.VERTICAL}
            onScroll={(
                source: Gtk.EventControllerScroll,
                arg0: number,
                arg1: number
            ) => {
                show()
                driver.volume -= arg1 / 100
                return true
            }}
        />
        <Gtk.GestureClick
            button={3}
            onPressed={() => {
                show()
                driver.mute = !driver.mute
                return true
            }}
        />
        <image iconName={createBinding(driver, "volumeIcon")} />
        <revealer
            revealChild={visible}
            transitionType={Gtk.RevealerTransitionType.SLIDE_RIGHT}
        >
            <label
                marginStart={5}
                class={createBinding(driver, "mute").as((v) => v ? "muted" : "")}
                label={createBinding(driver, "volume").as((v: number) => `${(v * 100).toFixed(0)}%`)} 
                />
        </revealer>
    </box>) as Gtk.MenuButton // TS Jank, For some reason it a type error 
}


function ButtonLabel() {
    // Examples, Wifi, Power profile, Speaker and or microphone volume, Battery.
    // Configurable?

    const { defaultSpeaker: speaker } = AstalWp.get_default()!
    const { defaultMicrophone: microphone } = AstalWp.get_default()!
    
    const labelBox = new Gtk.Box()
    labelBox.spacing = 7
    
    // @TODO Configuration check speaker
    if (true) {
        labelBox.append(audioWidget(speaker))
    }
    // @TODO Configuration check Microphone
    if (true) {
        labelBox.append(audioWidget(microphone))
    }

    return labelBox
}


export default function QSettings() {
    return <box
        cssClasses={["QSettings"]}
    >
        <Gtk.GestureClick
            button={1}
            onPressed={() => {
                registry.execute(["qSettings"], true)
            }}
        />
        <ButtonLabel />
    </box>;
}
