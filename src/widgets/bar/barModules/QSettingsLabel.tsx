import { Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import { timeout } from "ags/time"
import AstalWp from "gi://AstalWp?version=0.1"
import { createBinding, createComputed, createState, onCleanup, With } from "gnim"
import CommandRegistry from "../../../lib/requestHandler"
import { SliderSection } from "../../QSettings/SliderSection"
import AstalPowerProfiles from "gi://AstalPowerProfiles?version=0.1"
import AstalBattery from "gi://AstalBattery?version=0.1"
import ArchUpdates from "../../../lib/archUpdates"
import trayNeedsAttention from "../../../lib/trayAttention"
import vpnStatus from "../../../lib/vpn"
import { inhibited } from "../../../lib/idleInhibit"
import { recording } from "../../../lib/capture"
import Brightness from "../../../lib/brightness"
import { alarming } from "../../../lib/sleepTimer"
import { execAsync, timeoutAdd, sourceRemove } from "../../../lib/metrics"
import Config, { pendingUpdates } from "../../../config"
import { pressable } from "../../pressable"

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
    const disposers = [createBinding(driver, "volume").subscribe(show)]
    onCleanup(() => {
        for (const d of disposers) d()
    })
    const [tooltip, setTooltip] = createState("")

    const updateTooltip = () => {
        // device names/descriptions are hardware-controlled ("Tom &
        // Jerry's Headphones") — tooltipMarkup parses Pango markup;
        // either can also be null transiently
        setTooltip(`${GLib.markup_escape_text(driver.name ?? "", -1)}  
${GLib.markup_escape_text(driver.description ?? "", -1)}`) // Keep this indent. New line.
    }
    updateTooltip()
    disposers.push(
        createBinding(driver, "name").subscribe(() => {
            updateTooltip()
        }),
    )
    disposers.push(
        createBinding(driver, "description").subscribe(() => {
            updateTooltip()
        }),
    )

    return (
        <box tooltipMarkup={tooltip}>
            <Gtk.EventControllerScroll
                flags={Gtk.EventControllerScrollFlags.VERTICAL}
                onScroll={(source: Gtk.EventControllerScroll, arg0: number, arg1: number) => {
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
            <revealer revealChild={visible} transitionType={Gtk.RevealerTransitionType.SLIDE_RIGHT}>
                <label
                    marginStart={5}
                    class={createBinding(driver, "mute").as(v => (v ? "muted" : ""))}
                    label={createBinding(driver, "volume").as(
                        (v: number) => `${Math.floor(v * 100)}%`,
                    )}
                />
            </revealer>
        </box>
    ) as Gtk.MenuButton // TS Jank, For some reason it a type error
}

// brightness twin of audioWidget: scroll adjusts the level in fixed
// steps, hover reveals the percentage, right-click restores the
// previous level (the lib's restorePrevious)
function brightnessWidget() {
    const brightness = Brightness.get_default()
    if (!brightness.screenIsPresent) return null

    const screen = createBinding(brightness, "screen")
    const previous = createBinding(brightness, "previous")

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

    // released when the bar is destroyed (monitor hotplug) — same
    // pattern as audioWidget/Battery in this file
    const disposers = [screen.subscribe(show)]
    onCleanup(() => {
        for (const d of disposers) d()
    })

    return (
        <box
            cssClasses={["brightness"]}
            tooltipText={screen.as(v => `Brightness ${Math.floor(v * 100)}%`)}
        >
            <Gtk.EventControllerScroll
                flags={Gtk.EventControllerScrollFlags.VERTICAL}
                onScroll={(controller, _dx, dy) => {
                    show()
                    // step depends on the device: mouse wheels deliver
                    // one event per notch (WHEEL unit; magnitude varies
                    // by compositor — ±2 here) → sign-based 2% per notch;
                    // touchpads stream small smooth deltas (SURFACE unit,
                    // ~46u per micro-adjust) → 0.1%/unit ≈ 5% per
                    // micro-adjust. Touchpad keeps its original
                    // direction; wheel up = brighter
                    const delta =
                        controller.get_unit() === Gdk.ScrollUnit.WHEEL
                            ? dy < 0
                                ? 0.02
                                : -0.02
                            : dy * 0.001
                    brightness.screen = Math.min(1, Math.max(0.05, brightness.screen + delta))
                    return true
                }}
            />
            <Gtk.GestureClick
                button={3}
                onPressed={() => {
                    show()
                    if (previous.get() >= 0) brightness.restorePrevious()
                    return true
                }}
            />
            {/* middle-click: toggle between the two restore levels, or
            jump to 100% when nothing was recorded yet */}
            <Gtk.GestureClick
                button={2}
                onPressed={() => {
                    show()
                    if (previous.get() >= 0) brightness.restorePrevious()
                    else brightness.screen = 1
                    return true
                }}
            />
            <image iconName={"display-brightness-symbolic"} />
            <revealer revealChild={visible} transitionType={Gtk.RevealerTransitionType.SLIDE_RIGHT}>
                <label marginStart={5} label={screen.as(v => `${Math.floor(v * 100)}%`)} />
            </revealer>
        </box>
    ) as Gtk.Widget // TS jank, same as audioWidget
}

function powerProfile() {
    const powerProfiles = AstalPowerProfiles.get_default()
    const activeProfile = createBinding(powerProfiles, "activeProfile")
    return (
        <image
            marginStart={1}
            iconName={activeProfile.as(v => `power-profile-${v}-symbolic`)}
            tooltipText={activeProfile.as(v => `Active PowerProfile ${v}`)}
        />
    ) as Gtk.Image // TS Jank,
}

// only visible while holding, like the VPN indicator below: a
// keep-awake you forgot about is the failure mode, so it has to be
// visible on the bar rather than only inside quick settings
function keepAwakeIndicator() {
    return (
        <image
            iconName={"caffeine-symbolic"}
            visible={inhibited}
            tooltipText={"Keep awake is on — the screen will not idle"}
        />
    ) as Gtk.Image // TS Jank
}

// A recording in progress is the one shell state that MUST be visible:
// the whole failure mode is forgetting it is running. Its own class so
// scss can make it red and pulse it.
function recordingIndicator() {
    return (
        <image
            cssClasses={["recordingDot"]}
            iconName={"media-record-symbolic"}
            visible={recording}
            tooltipText={"Recording — run `record` again to stop"}
        />
    ) as Gtk.Image // TS Jank
}

function vpnIndicator() {
    // only visible while connected, like GNOME
    return (
        <image
            iconName={"network-vpn-symbolic"}
            visible={vpnStatus.as(s => s.connected)}
            tooltipText={vpnStatus.as(s => `VPN connected: ${s.relay}`)}
        />
    ) as Gtk.Image // TS Jank
}

function Battery() {
    const bat = AstalBattery.get_default()
    const batIcon = createBinding(bat, "batteryIconName")

    const batTimeConvert = (timeRemaining: number, charging: boolean): string => {
        // at the charge limit UPower still reports a timeToFull even
        // though nothing is charging; its charging state flickers at
        // the cap too, so judge by percentage alone
        const cap = Config.quicksettings.batteryFullAt
        if (bat.percentage * 100 >= cap - 2)
            return `${Math.floor(bat.percentage * 100)}% · Charge limit`

        if (timeRemaining <= 0) return charging ? "Fully charged" : "Unknown ammount of time left"

        const hours = Math.floor(timeRemaining / 3600)
        const minutes = Math.floor((timeRemaining % 3600) / 60)

        const parts: string[] = []

        if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? "s" : ""}`)
        if (minutes > 0) parts.push(`${minutes} minute${minutes !== 1 ? "s" : ""}`)

        const suffix = charging ? "until full" : "left"
        const prefix = charging ? "Charging..." : "Discharging..."
        const percentage = Math.floor(bat.percentage * 100).toString()

        return `${prefix} ${percentage}% ${parts.join(" ")} ${suffix}`
    }

    const [showPrec, setShowPrec] = createState(!bat.charging && bat.percentage < 0.2)
    const [batTime, setBatTime] = createState(
        batTimeConvert(bat.charging ? bat.timeToFull : bat.timeToEmpty, bat.charging),
    )

    // released when the bar is destroyed (monitor hotplug)
    const disposers: (() => void)[] = []
    onCleanup(() => {
        for (const d of disposers) d()
    })

    disposers.push(
        createBinding(bat, "timeToEmpty").subscribe(() => {
            if (!bat.get_charging()) setBatTime(batTimeConvert(bat.timeToEmpty, bat.get_charging()))
        }),
    )

    disposers.push(
        createBinding(bat, "timeToFull").subscribe(() => {
            if (bat.get_charging()) setBatTime(batTimeConvert(bat.timeToFull, bat.get_charging()))
        }),
    )

    const updateLow = () => setShowPrec(!bat.charging && bat.percentage < 0.2)
    disposers.push(createBinding(bat, "percentage").subscribe(updateLow))
    // plugging in while low must clear the styling even if the
    // percentage has not moved yet
    disposers.push(createBinding(bat, "charging").subscribe(updateLow))
    return (
        <box tooltipText={batTime} cssClasses={showPrec.as(v => (v ? ["batLow"] : []))}>
            <image iconName={batIcon} />
            {Config.quicksettings.showBatteryPercentage && (
                <label
                    cssClasses={["batteryPercent"]}
                    marginStart={5}
                    label={createBinding(bat, "percentage").as(v => `${Math.floor(v * 100)}%`)}
                />
            )}
        </box>
    ) as Gtk.Widget // TS jank
}

function Updates() {
    const archUpdates = ArchUpdates.get_default()

    return (
        <revealer
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
                        execAsync([
                            "kitty",
                            "--hold",
                            "-e",
                            `${Config.instanceSrcDir}/scripts/archlinux-update.sh`,
                        ]).catch(e => console.warn("updates launcher failed:", e))
                    }}
                />
                <label
                    label={createBinding(archUpdates, "updates-num").as(u => `󰁠 ${u}`)}
                    tooltipText={createBinding(archUpdates, "updates")}
                />
            </box>
        </revealer>
    ) as Gtk.Widget // TS jank
}

function ButtonLabel() {
    // Examples, Wifi, Power profile, Speaker and or microphone volume, Battery.
    // Configurable?

    const bat = AstalBattery.get_default()

    const wp = AstalWp.get_default()

    // audio widgets re-bind to the current default device: snapshotting
    // wp.defaultSpeaker once left scroll/volume controlling the old
    // endpoint after the user switched outputs (the OSD path rebinds;
    // the bar did not)
    return (
        <box spacing={12}>
            {wp && (
                <With value={createBinding(wp, "defaultSpeaker")}>
                    {speaker => speaker && audioWidget(speaker)}
                </With>
            )}
            {wp && (
                <With value={createBinding(wp, "defaultMicrophone")}>
                    {microphone => microphone && audioWidget(microphone)}
                </With>
            )}
            {brightnessWidget()}
            {Config.quicksettings.powerProfileOnPanel && powerProfile()}
            {keepAwakeIndicator()}
            {recordingIndicator()}
            {vpnIndicator()}
            {bat.isPresent && <Battery />}
            {/* Bound, not read once: the daemon probe in config.ts is
            async and lands AFTER this widget is built, so reading a
            static here left a stale package list on the bar next to a
            stopped daemon. `null` is "still probing" and renders
            nothing, so nothing flashes on and off at login either.

            Wrapped in its OWN box, and that is not decoration. gnim's
            append() forwards a Fragment's later children straight to the
            parent's appendChild — Gtk.Box.vfunc_add_child, which appends
            at the END — and does not remember where the Fragment sat. A
            bare `With` here therefore drops the pill to the right of the
            tray-attention dot the moment the probe answers, instead of
            between the battery and the dot. Inside a box of its own the
            box holds the slot and the late append lands in it. */}
            {/* visibility bound too: the parent box carries spacing={12},
            and GTK counts an empty-but-visible child as a child — so an
            unconditionally visible wrapper would leave a 12px hole in the
            cluster on every machine without the daemon */}
            <box visible={pendingUpdates.as(active => active === true)}>
                <With value={pendingUpdates}>{active => active === true && <Updates />}</With>
            </box>

            {/* Dot shown when a nested tray item needs attention */}
            {!Config.tray.onPanel && (
                <label
                    label="●"
                    cssClasses={["tray-attention"]}
                    visible={trayNeedsAttention}
                    tooltipText={"A tray item needs attention"}
                />
            )}
        </box>
    )
}

export default function QSettings() {
    // flash the label as a vibrant accent block while the sleep
    // timer's alarm rings: no notification — the panel itself calls
    // for attention. JS-driven flip (600ms): CSS opacity animations
    // don't run in this shell
    const [flashOn, setFlashOn] = createState(false)
    let flashSource = 0
    const unsub = alarming.subscribe(() => {
        if (alarming.get()) {
            if (flashSource === 0)
                flashSource = timeoutAdd("bar:alarmFlash", GLib.PRIORITY_DEFAULT, 600, () => {
                    setFlashOn(!flashOn.get())
                    return true
                })
        } else {
            if (flashSource !== 0) {
                sourceRemove(flashSource)
                flashSource = 0
            }
            setFlashOn(false)
        }
    })
    // the bar mount dies with its monitor on hotplug: the subscription
    // and any armed flash timer must die with it
    onCleanup(() => {
        unsub()
        if (flashSource !== 0) {
            sourceRemove(flashSource)
            flashSource = 0
        }
    })
    return (
        <box
            cssClasses={createComputed([alarming, flashOn], (a, f) => [
                "QSettings",
                ...(a && f ? ["alarmAttention"] : []),
            ])}
        >
            <Gtk.GestureClick
                button={1}
                {...pressable(() => {
                    registry.execute(["qSettings"], true)
                })}
            />
            <ButtonLabel />
        </box>
    )
}
