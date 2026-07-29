import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import { timeout } from "ags/time"
import AstalWp from "gi://AstalWp?version=0.1"
import { createBinding, createState, onCleanup } from "gnim"
import CommandRegistry from "../../../lib/requestHandler"
import { SliderSection } from "../../QSettings/SliderSection"
import AstalPowerProfiles from "gi://AstalPowerProfiles?version=0.1"
import AstalBattery from "gi://AstalBattery?version=0.1"
import ArchUpdates from "../../../lib/archUpdates"
import trayNeedsAttention from "../../../lib/trayAttention"
import vpnStatus from "../../../lib/vpn"
import { execAsync } from "ags/process"
import Config from "../../../config"

const registry = CommandRegistry.get_default()


/**
 * POLICY
 * Do not use mouse one for any label widget as its used for opening the Quick
 * -settings. 
 */

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
    // disposers released when the bar is destroyed (monitor hotplug) —
    // Battery() in this file already follows the same pattern
    const disposers = [
        createBinding(driver, "volume").subscribe(show),
    ]
    onCleanup(() => { for (const d of disposers) d() })
    const [tooltip, setTooltip] = createState("")

    const updateTooltip = () => {
        // device names/descriptions are hardware-controlled ("Tom &
        // Jerry's Headphones") — tooltipMarkup parses Pango markup;
        // either can also be null transiently
        setTooltip(`${GLib.markup_escape_text(driver.name ?? "", -1)}  
${GLib.markup_escape_text(driver.description ?? "", -1)}`) // Keep this indent. New line.
    }
    updateTooltip()
    disposers.push(createBinding(driver, "name").subscribe(() => { updateTooltip() }))
    disposers.push(createBinding(driver, "description").subscribe(() => { updateTooltip() }))

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
                // Fixed step per notch, raw deltas vary wildly between
                // devices and can be imperceptibly small
                const step = arg1 < 0 ? 0.05 : -0.05
                driver.volume = Math.min(1, Math.max(0, driver.volume + step))
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

function vpnIndicator() {
    // only visible while connected, like GNOME
    return (<image
        iconName={"network-vpn-symbolic"}
        visible={vpnStatus.as(s => s.connected)}
        tooltipText={vpnStatus.as(s => `VPN connected: ${s.relay}`)}
    />) as Gtk.Image // TS Jank
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
        const percentage = Math.floor(bat.percentage * 100).toString()

        return `${prefix} ${percentage}% ${parts.join(" ")} ${suffix}`;
    };

    const [showPrec, setShowPrec] = createState(!bat.charging && bat.percentage < .20)
    const [batTime, setBatTime] = createState(batTimeConvert(
        (bat.charging) ? bat.timeToFull : bat.timeToEmpty, bat.charging))

    // released when the bar is destroyed (monitor hotplug)
    const disposers: (() => void)[] = []
    onCleanup(() => {
        for (const d of disposers) d()
    })

    disposers.push(createBinding(bat, "timeToEmpty").subscribe(() => {
        if (!bat.get_charging())
            setBatTime(batTimeConvert(bat.timeToEmpty, bat.get_charging()))
    }))

    disposers.push(createBinding(bat, "timeToFull").subscribe(() => {
        if (bat.get_charging())
            setBatTime(batTimeConvert(bat.timeToFull, bat.get_charging()))
    }))

    const updateLow = () => setShowPrec(!bat.charging && bat.percentage < .20)
    disposers.push(createBinding(bat, "percentage").subscribe(updateLow))
    // plugging in while low must clear the styling even if the
    // percentage has not moved yet
    disposers.push(createBinding(bat, "charging").subscribe(updateLow))
    return (<box
        tooltipText={batTime}
        cssClasses={showPrec.as((v) => v ? ["batLow"] : [])}
    >
        <image iconName={batIcon} />
        {Config.quicksettings.showBatteryPercentage &&
            <label
                marginStart={5}
                label={createBinding(bat, "percentage").as(
                    (v) => `${Math.floor(v * 100)}%`)}
            />
        }
    </box>) as Gtk.Widget // TS jank
}

function Updates() {
    const archUpdates = ArchUpdates.get_default()

    return (<revealer
        transitionDuration={250}
        transitionType={Gtk.RevealerTransitionType.SLIDE_LEFT}
        revealChild={createBinding(archUpdates, "overthreshold")}
    >
        <box>
            <Gtk.GestureClick
                button={3}
                onPressed={() => {
                    // @TODO Run independent of shell, we don't want to stop
                    // updating mid update.
                    execAsync(["kitty", "--hold", "-e",
                        `${Config.instanceSrcDir}/scripts/archlinux-update.sh`])
                        .catch(e => console.warn("updates launcher failed:", e))
                }}
            />
            <label
                label={createBinding(archUpdates, "updatesnum").as(u => `󰁠 ${u}`)}
                tooltipText={createBinding(archUpdates, "updates")}
            />
        </box>
    </revealer>) as Gtk.Widget // TS jank
}

function ButtonLabel() {
    // Examples, Wifi, Power profile, Speaker and or microphone volume, Battery.
    // Configurable?

    const bat = AstalBattery.get_default()

    const wp = AstalWp.get_default()
    // null when pipewire has no devices; audioWidget can't take null
    const speaker = wp?.defaultSpeaker ?? null
    const microphone = wp?.defaultMicrophone ?? null

    const labelBox = new Gtk.Box()
    labelBox.spacing = 12

    if (speaker) labelBox.append(audioWidget(speaker))
    if (microphone) labelBox.append(audioWidget(microphone))
    labelBox.append(powerProfile())
    labelBox.append(vpnIndicator())
    if (bat.isPresent) {
        labelBox.append(Battery())
    }

    if (Config.pendingUpdates) {
        labelBox.append(Updates())
    }

    // Dot shown when a nested tray item needs attention
    if (!Config.tray.onPanel) {
        labelBox.append(
            <label
                label="●"
                cssClasses={["tray-attention"]}
                visible={trayNeedsAttention}
                tooltipText={"A tray item needs attention"}
            /> as Gtk.Widget
        )
    }

    return labelBox
}


export default function QSettings() {
    return <box
        cssClasses={["QSettings"]}
    >
        <Gtk.EventControllerMotion
            onEnter={() => {
                registry.execute(["qSettingsShow"], true)
            }}
        />
        <Gtk.GestureClick
            button={1}
            onPressed={() => {
                registry.execute(["qSettings"], true)
            }}
        />
        <ButtonLabel />
    </box>;
}
