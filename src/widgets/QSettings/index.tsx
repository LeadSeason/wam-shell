import Graphene from "gi://Graphene?version=1.0"
import AstalMpris from "gi://AstalMpris?version=0.1"

import { Astal, Gdk, Gtk } from "ags/gtk4"
import { timeout } from "ags/time"

import Tray from "./tray"
import Config from "../../config"
import CommandRegistry from "../../lib/requestHandler"
import { isPinned } from "../../lib/trayPinned"
import { refreshHyprsunset } from "../../lib/hyprsunset"
import { hideOnFocusLoss } from "../../lib/popupFocus"

import { createBinding, createState } from "gnim"
import { hookPlayers } from "../../lib/mpris"
import { ToggleSection } from "./toggleSection"
import { HeaderSection } from "./HeaderSection"
import { SliderSection } from "./SliderSection"
import { MediaSection, setQsVisible } from "./MediaSection"
import { WifiWidget, WifiSwitch } from "./toggleSection/wifi"
import { WiredWidget, WiredSwitch } from "./toggleSection/wired"
import { BluetoothWidget, BtSwitch } from "./toggleSection/bluetooth"
import { PowerProfilesWidget } from "./toggleSection/powerProfile"
import { VpnPane, VpnSwitch } from "./toggleSection/vpnPane"

const registry = CommandRegistry.get_default()

function PaneHeader({
    title,
    onBack,
    trailing,
}: {
    title: string
    onBack: () => void
    trailing?: Gtk.Widget
}) {
    return (
        <box cssClasses={["paneHeader"]} spacing={5}>
            {/* back is its own small button (hover covers only icon +
            title, never the trailing switch): the gesture box must not
            hexpand, or it swallows switch clicks; the spacer pushes
            the switch right and takes no gesture */}
            <box cssClasses={["paneHeaderBack"]} spacing={5}>
                <Gtk.GestureClick button={1} onPressed={onBack} />
                <image iconName="go-previous-symbolic" />
                <label label={title} xalign={0} />
            </box>
            <box hexpand />
            {trailing}
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
        // For some reason it does'nt want to play the animation, Setting
        // timeout to 0 for this reason
        revealer.set_reveal_child(false)
        setQsVisible(false)
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
        // a hide may have a pending win.hide(); cancel it
        hideTimer?.cancel()
        hideTimer = null
        // the sliders should reflect external hyprsunset changes now,
        // not whenever the 30s watch happens to tick next
        refreshHyprsunset()
        setQsVisible(true)
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
        description: "Show QuickSettings without toggling",
        main: () => {
            if (win && !win.is_visible()) {
                show()
                return "QSettings, window show"
            }
            return "QSettings, already visible"
        },
    })

    // playback starting means the user is done with the popup: they
    // pressed play in the media section, or a video started elsewhere
    // — either way, get out of the way of what they want to watch.
    // Only the transition INTO playing counts, so pausing from the
    // popup (and a player merely appearing paused) leaves it open
    function hideOnPlay(p: AstalMpris.Player) {
        if (p.playbackStatus !== AstalMpris.PlaybackStatus.PLAYING) return
        if (!win?.is_visible()) return
        hide()
    }

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
    return (
        <window
            $={ref => {
                win = ref
                hideOnFocusLoss(win, hide)
                // one hook for every current and future player; the
                // registration lives as long as this window does (the
                // whole session), like the focus watcher above
                if (Config.quicksettings.hideOnMediaPlay)
                    hookPlayers(p => {
                        hideOnPlay(p) // a player that shows up already playing
                        return createBinding(p, "playbackStatus").subscribe(() => hideOnPlay(p))
                    })
            }}
            name="QSettings"
            class="QSettings"
            namespace={`${Config.instanceName}QSettings`}

            anchor={TOP | BOTTOM | LEFT | RIGHT}
            // Keep the overlay below the bar so bar widgets (volume scroll,
            // buttons) stay interactive while the popup is open
            marginTop={30}
            // ON_DEMAND, not EXCLUSIVE: the grab stole input from other
            // surfaces; focus loss closes the window instead (popupFocus)
            keymode={Astal.Keymode.ON_DEMAND}
        >
            <Gtk.EventControllerKey onKeyPressed={onKey} />
            <Gtk.GestureClick onPressed={onClick} />
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
                    {/* the scrolled window pins the width: without it the
                    card's natural width is child-driven, and a wide
                    fallback font (missing Nerd Fonts) or long content
                    inflates the popup far past its design width */}
                    <Gtk.ScrolledWindow
                        vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
                        hscrollbarPolicy={Gtk.PolicyType.NEVER}
                        propagateNaturalHeight
                        widthRequest={Config.quicksettings.width}
                    >
                        <stack
                            // one consistent shell size: panes match the
                            // tallest instead of shrinking to fit their
                            // content. Panes with nothing to show fill the
                            // space with a centered empty state (.paneEmpty)
                            vhomogeneous
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
                            <box
                                $type="named"
                                name="main"
                                orientation={Gtk.Orientation.VERTICAL}
                                // uniform rhythm: 8px between the cards
                                // (sections are cards now — no separators)
                                spacing={8}
                            >
                                {/* header (battery, power, …) only on the main pane */}
                                <HeaderSection />
                                <SliderSection />
                                {toggleSection.widget}
                                {/* tray always above the player */}
                                {!Config.tray.onPanel && (
                                    <Tray
                                        filter={item => !isPinned(item)}
                                        iconSize={Config.tray.popupIconSize}
                                        pill
                                        spacing={2}
                                    />
                                )}
                                <MediaSection />
                            </box>
                            <box $type="named" name="wifi" orientation={Gtk.Orientation.VERTICAL}>
                                <PaneHeader
                                    title="Wi-Fi"
                                    onBack={() => setPane("main")}
                                    trailing={<WifiSwitch />}
                                />
                                <WifiWidget pane={pane} name="wifi" />
                            </box>
                            <box
                                $type="named"
                                name="bluetooth"
                                orientation={Gtk.Orientation.VERTICAL}
                            >
                                <PaneHeader
                                    title="Bluetooth"
                                    onBack={() => setPane("main")}
                                    trailing={<BtSwitch />}
                                />
                                <BluetoothWidget pane={pane} name="bluetooth" />
                            </box>
                            <box $type="named" name="wired" orientation={Gtk.Orientation.VERTICAL}>
                                <PaneHeader
                                    title="Wired"
                                    onBack={() => setPane("main")}
                                    trailing={<WiredSwitch />}
                                />
                                <WiredWidget pane={pane} name="wired" />
                            </box>
                            <box $type="named" name="vpn" orientation={Gtk.Orientation.VERTICAL}>
                                <PaneHeader
                                    title="VPN"
                                    onBack={() => setPane("main")}
                                    trailing={<VpnSwitch />}
                                />
                                <VpnPane pane={pane} name="vpn" />
                            </box>
                            <box
                                $type="named"
                                name="powerprofiles"
                                orientation={Gtk.Orientation.VERTICAL}
                            >
                                <PaneHeader title="Power Mode" onBack={() => setPane("main")} />
                                {/* the pane outgrew the shell's uniform
                                height (main): scroll inside the pane
                                instead of stretching the window and
                                leaving the main pane with dead space.
                                No propagateNaturalHeight, so the stack
                                keeps sizing to main */}
                                <Gtk.ScrolledWindow
                                    vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
                                    hscrollbarPolicy={Gtk.PolicyType.NEVER}
                                    vexpand
                                >
                                    <PowerProfilesWidget pane={pane} name="powerprofiles" />
                                </Gtk.ScrolledWindow>
                            </box>
                        </stack>
                    </Gtk.ScrolledWindow>
                </box>
            </revealer>
        </window>
    )
}
