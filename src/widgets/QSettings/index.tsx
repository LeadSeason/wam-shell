import Graphene from "gi://Graphene?version=1.0"
import GLib from "gi://GLib?version=2.0"

import { Astal, Gdk, Gtk } from "ags/gtk4"
import { timeout } from "ags/time"

import Tray from "./tray"
import Config from "../../config"
import CommandRegistry from "../../lib/requestHandler"
import { isPinned } from "../../lib/trayPinned"
import { refreshHyprsunset } from "../../lib/hyprsunset"

import { createState } from "gnim"
import { ToggleSection } from "./toggleSection"
import { HeaderSection } from "./HeaderSection"
import { SliderSection } from "./SliderSection"
import { MediaSection } from "./MediaSection"
import { StatsSection } from "./StatsSection"
import { WifiWidget } from "./toggleSection/wifi"
import { WiredWidget } from "./toggleSection/wired"
import { BluetoothWidget } from "./toggleSection/bluetooth"
import { PowerProfilesWidget } from "./toggleSection/powerProfile"

const registry = CommandRegistry.get_default()

function PaneHeader({ title, onBack }: { title: string; onBack: () => void }) {
    return (
        <box cssName="button" spacing={5}>
            <Gtk.GestureClick button={1} onPressed={onBack} />
            <image iconName="go-previous-symbolic" />
            <label label={title} hexpand xalign={0} />
        </box>
    )
}

export default function QSettings() {
    const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor
    let win: Astal.Window
    let contentBox: Gtk.Box
    let revealer: Gtk.Revealer
    const [pane, setPane] = createState("main")
    const toggleSection = ToggleSection({ onNavigate: setPane })
    let hideTimer: ReturnType<typeof timeout> | null = null

    function hide() {
        cancelClose()
        // For some reason it does'nt want to play the animation, Setting
        // timeout to 0 for this reason
        revealer.set_reveal_child(false)
        // give some time for the animation to play.
        hideTimer?.cancel()
        hideTimer = timeout(50, () => {
            hideTimer = null
            win.hide()
            toggleSection.reset()
            setPane("main")
        })
    }

    function show() {
        hasEntered = false
        cancelClose()
        // a hide may have a pending win.hide(); cancel it
        hideTimer?.cancel()
        hideTimer = null
        // the sliders should reflect external hyprsunset changes now,
        // not whenever the 30s watch happens to tick next
        refreshHyprsunset()
        win.present()
        revealer.set_reveal_child(true)
    }

    registry.register({
        name: ["qSettings", "quickSettings"],
        description: "Show QuickSettings",
        main: (argv: string[]) => {
            if (win) {
                if (!win.is_visible()) {
                    show()
                    return "QSettings, window show"
                } else {
                    hide()
                    return "QSettings, window hidden"
                }
            }
            return `QSettings, No window is defined, Maybe running on hyprland?
        Scratchpad is sway-specific`
        },
    })

    registry.register({
        name: ["qSettingsShow"],
        description: "Show QuickSettings without toggling (used for hover open)",
        main: () => {
            if (win && !win.is_visible()) {
                show()
                return "QSettings, window show"
            }
            return "QSettings, already visible"
        },
    })

    // close on ESC
    function onKey(_e: Gtk.EventControllerKey, keyValue: number, _: number, mod: number) {
        if (keyValue === Gdk.KEY_Escape) {
            hide()
            return
        }
    }

    // close on click away
    function onClick(_e: Gtk.GestureClick, _: number, x: number, y: number) {
        const [, rect] = contentBox.compute_bounds(win)
        const position = new Graphene.Point({ x, y })

        if (!rect.contains_point(position)) {
            hide()
            return
        }
    }

    // close shortly after the pointer leaves the popup. Motion is tracked
    // on the fullscreen overlay: tray popover menus are separate windows,
    // so while the pointer is over one no motion reaches the overlay and
    // no close is triggered.
    let closeSource: number | null = null
    function scheduleClose() {
        if (closeSource !== null) return
        closeSource = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            Config.quicksettings.closeDelay,
            () => {
                closeSource = null
                if (win.is_visible()) hide()
                return GLib.SOURCE_REMOVE
            },
        )
    }
    function cancelClose() {
        if (closeSource !== null) {
            GLib.source_remove(closeSource)
            closeSource = null
        }
    }

    // Only arm auto-close after the pointer has been inside the popup:
    // when opened by hovering the bar button, the overlay appears under
    // the pointer while it is still outside the popup, which would
    // otherwise immediately schedule a close and flicker.
    let hasEntered = false

    function onMotion(_e: Gtk.EventControllerMotion, x: number, y: number) {
        const [, rect] = contentBox.compute_bounds(win)

        // The popup has a margin around it (for its shadow) which is
        // outside its bounds: a pointer resting in that strip counts as
        // outside while visually being on the popup, and if it overlaps
        // the bar button it causes a close/open flicker loop. Treat a
        // buffer around the popup as inside.
        const BUFFER = 12
        const { x: rx, y: ry } = rect.origin
        const { width, height } = rect.size
        const inside =
            x >= rx - BUFFER &&
            x <= rx + width + BUFFER &&
            y >= ry - BUFFER &&
            y <= ry + height + BUFFER

        if (inside) {
            hasEntered = true
            cancelClose()
        } else if (hasEntered) {
            scheduleClose()
        }
    }
    return (
        <window
            $={ref => {
                win = ref
            }}
            name="QSettings"
            class="QSettings"
            namespace={`${Config.instanceName}QSettings`}

            anchor={TOP | BOTTOM | LEFT | RIGHT}
            // Keep the overlay below the bar so bar widgets (volume scroll,
            // buttons) stay interactive while the popup is open
            marginTop={30}
            keymode={Astal.Keymode.EXCLUSIVE}
        >
            <Gtk.EventControllerKey onKeyPressed={onKey} />
            <Gtk.GestureClick onPressed={onClick} />
            <Gtk.EventControllerMotion onMotion={onMotion} />
            <revealer
                $={ref => (revealer = ref)}
                transitionDuration={200}
                transition_type={Gtk.RevealerTransitionType.SLIDE_DOWN}
            >
                <box
                    $={ref => (contentBox = ref)}
                    valign={Gtk.Align.START}
                    halign={Gtk.Align.END}
                    orientation={Gtk.Orientation.VERTICAL}
                    cssClasses={["qSettings"]}
                    widthRequest={240}
                >
                    <stack
                        // set the visible child after construction: as a prop it
                        // is applied before the named children exist, which makes
                        // Gtk warn about a missing child
                        $={self => {
                            self.visibleChildName = "main"
                            // subscribe callbacks receive no value, read it
                            pane.subscribe(() => (self.visibleChildName = pane.get()))
                        }}
                        transitionType={Gtk.StackTransitionType.SLIDE_LEFT_RIGHT}
                        transitionDuration={200}
                    >
                        <box $type="named" name="main" orientation={Gtk.Orientation.VERTICAL}>
                            {/* header (battery, power, …) only on the main pane */}
                            <HeaderSection />
                            <SliderSection />
                            <Gtk.Separator />
                            {toggleSection.widget}
                            {Config.quicksettings.showStats && <StatsSection />}
                            <MediaSection />
                            {!Config.tray.onPanel && <Gtk.Separator />}
                            {!Config.tray.onPanel && (
                                <Tray
                                    filter={item => !isPinned(item)}
                                    iconSize={Config.tray.popupIconSize}
                                    pill
                                    spacing={8}
                                />
                            )}
                        </box>
                        <box $type="named" name="wifi" orientation={Gtk.Orientation.VERTICAL}>
                            <PaneHeader title="Wi-Fi" onBack={() => setPane("main")} />
                            <WifiWidget pane={pane} name="wifi" />
                        </box>
                        <box $type="named" name="bluetooth" orientation={Gtk.Orientation.VERTICAL}>
                            <PaneHeader title="Bluetooth" onBack={() => setPane("main")} />
                            <BluetoothWidget pane={pane} name="bluetooth" />
                        </box>
                        <box $type="named" name="wired" orientation={Gtk.Orientation.VERTICAL}>
                            <PaneHeader title="Wired" onBack={() => setPane("main")} />
                            <WiredWidget pane={pane} name="wired" />
                        </box>
                        <box
                            $type="named"
                            name="powerprofiles"
                            orientation={Gtk.Orientation.VERTICAL}
                        >
                            <PaneHeader title="Power Mode" onBack={() => setPane("main")} />
                            <PowerProfilesWidget />
                        </box>
                    </stack>
                </box>
            </revealer>
        </window>
    )
}
