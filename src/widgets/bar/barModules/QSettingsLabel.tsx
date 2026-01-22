import { Gtk } from "ags/gtk4"
import { timeout } from "ags/time"
import AstalWp from "gi://AstalWp?version=0.1"
import { createBinding, createState } from "gnim"
import CommandRegistry from "../../../lib/requestHandler"
import { SliderSection } from "../../QSettings/SliderSection"
import AstalPowerProfiles from "gi://AstalPowerProfiles?version=0.1"
import AstalBattery from "gi://AstalBattery?version=0.1"

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
    const [tooltip, setTooltip] = createState("")
    
    const updateTooltip = () => {
        setTooltip(`${driver.name}  
${driver.description}`)
    }
    updateTooltip()
    createBinding(driver, "name").subscribe(() => {updateTooltip()})
    createBinding(driver, "description").subscribe(() => {updateTooltip()})

    return (<box
        tooltipMarkup={tooltip}
    >
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
                label={createBinding(driver, "volume").as((v: number) => `${Math.floor(v * 100)}%`)} 
                />
        </revealer>
    </box>) as Gtk.MenuButton // TS Jank, For some reason it a type error 
}

function powerProfile() {
    const powerProfiles = AstalPowerProfiles.get_default()
    const activeProfile = createBinding(powerProfiles, "activeProfile")
    return (
    <image
        marginStart={1}
        iconName={activeProfile.as(v => `power-profile-${v}-symbolic`)}
        tooltipText={activeProfile.as(v => `Active PowerProfile ${v}`)}
    />) as Gtk.Image // TS Jank,
}

function secondsToTime(t: number): string {
        /* @ts-expect-error */
        const date = new Date(null);
        date.setSeconds(t); // specify value for SECONDS here
        return date.toISOString().slice(11, 19);
}

function Battery() {
    const bat = AstalBattery.get_default()
    const batIcon = createBinding(bat, "batteryIconName")

    const batTimeConvert = (timeRemaining: number, charging: boolean): string => {
        if (timeRemaining <= 0) return charging ? "Fully charged" : "Unknown ammount of time left";

        const hours = Math.floor(timeRemaining / 3600);
        const minutes = Math.floor((timeRemaining % 3600) / 60);

        const parts: string[] = [];

        if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? "s" : ""}`);
        if (minutes > 0) parts.push(`${minutes} minute${minutes !== 1 ? "s" : ""}`);

        const suffix = charging ? "until full" : "left";
        const prefix = charging ? "Charging..." : "Discharging...";
        const procentage = Math.floor(bat.percentage * 100).toString()

        return `${prefix} ${procentage}${parts.join(" ")} ${suffix}`;
    };

    const [showPrec, setShowPrec] = createState(false)
    const [batTime, setBatTime] = createState(batTimeConvert(
        (bat.charging) ? bat.timeToEmpty : bat.timeToEmpty, bat.charging))

    createBinding(bat, "timeToEmpty").subscribe(() => {
    if (!bat.get_charging())
        setBatTime(batTimeConvert(bat.timeToFull, bat.get_charging()))})

    createBinding(bat, "timeToFull").subscribe(() => {
    if (bat.get_charging())
        setBatTime(batTimeConvert(bat.timeToFull, bat.get_charging()))})

    createBinding(bat, "percentage").subscribe(() => {
        let v = bat.percentage
        if (!bat.charging) {
            if (v < .20) {
                setShowPrec(true)
            } else {
                setShowPrec(false)
            }
        }
    })
    return (<box
        tooltipText={batTime}
        cssClasses={showPrec.as((v) => v ? ["batLow"] : [])}
    >
        <image iconName={batIcon} />
        <revealer
            revealChild={showPrec}
            transitionType={Gtk.RevealerTransitionType.SLIDE_RIGHT}
        >
            <label
                marginStart={5}
                label={createBinding(bat, "batteryLevel").as(
                    (v: number) => `${(v * 100).toFixed(0)}%`)} 
                />
        </revealer>
    </box>) as Gtk.Widget // TS jank
}

function ButtonLabel() {
    // Examples, Wifi, Power profile, Speaker and or microphone volume, Battery.
    // Configurable?

    const bat = AstalBattery.get_default()

    const { defaultSpeaker: speaker } = AstalWp.get_default()!
    const { defaultMicrophone: microphone } = AstalWp.get_default()!
    
    const labelBox = new Gtk.Box()
    labelBox.spacing = 7
    
    labelBox.append(audioWidget(speaker))
    labelBox.append(audioWidget(microphone))
    labelBox.append(powerProfile())
    if (bat.isPresent) {
        labelBox.append(Battery())

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
