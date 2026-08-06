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
import { AirplaneModeRow } from "./toggleSection/miscToggles"
import { AudioPane } from "./toggleSection/audioPane"
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

// Fixed pixel sizing is a bet on the developer's monitor: 520px is
// half of a 1080p panel but three quarters of a 1366x768 one — and of
// a 1080p screen at 1.5x scale, which is 720 logical px. Derive both
// numbers from the smallest attached monitor instead, capped at what
// feels right on a large screen. Read once: a hotplugged monitor is
// not worth re-laying-out a popup for
function smallestMonitorHeight(): number {
    const monitors = Gdk.Display.get_default()?.get_monitors()
    let smallest = Infinity
    for (let i = 0; i < (monitors?.get_n_items() ?? 0); i++) {
        const geometry = (monitors!.get_item(i) as Gdk.Monitor).get_geometry()
        if (geometry.height > 0) smallest = Math.min(smallest, geometry.height)
    }
    // no monitors is impossible in practice; assume 1080p over crashing
    return Number.isFinite(smallest) ? smallest : 1080
}

const SCREEN_HEIGHT = smallestMonitorHeight()
// the floor a pane never shrinks below: switching to a short pane
// should settle the popup, not yank it
const MIN_PANE_HEIGHT =
    Config.quicksettings.minHeight || Math.min(520, Math.round(SCREEN_HEIGHT * 0.45))
// a long list scrolls inside its own pane rather than growing the popup
const MAX_PANE_HEIGHT = Math.min(520, Math.round(SCREEN_HEIGHT * 0.5))

export default function QSettings() {
    const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor
    let win: Astal.Window
    let contentBox: Gtk.Box
    // every pane that scrolls internally, so they can be reset on switch
    const paneScrollers: Gtk.ScrolledWindow[] = []
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
        name: ["qsPane"],
        description: "Open QuickSettings on a specific pane",
        help: `qsPane <main|wifi|bluetooth|wired|vpn|powerprofiles|audioOutput|audioInput>
  Shows the popup and switches to that pane — bind it in the
  compositor to open straight into wifi, or drive it from a script.
  An unknown name lands on main.`,
        main: (argv: string[]) => {
            if (!win) return "QSettings, no window"
            if (!win.is_visible()) show()
            const target = argv[0] ?? "main"
            setPane(target)
            return `QSettings, pane ${target}`
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
                            // never shorter than this: panes size to
                            // their own content, but a short one
                            // (wired, vpn) collapsing the popup to a
                            // third of its height reads as the floor
                            // being pulled out. Roughly the main
                            // pane's own height, so opening a pane
                            // holds the size you started from
                            heightRequest={MIN_PANE_HEIGHT}
                            // each pane sizes to its own content: with
                            // vhomogeneous every pane inherited the
                            // tallest one, so a long wifi list left the
                            // main pane with a screen of dead space
                            // under the player. Tall panes cap
                            // themselves instead (scrollers below)
                            vhomogeneous={false}
                            // set the visible child after construction: as a prop it
                            // is applied before the named children exist, which makes
                            // Gtk warn about a missing child
                            $={self => {
                                self.visibleChildName = "main"
                                // subscribe callbacks receive no value, read it
                                pane.subscribe(() => {
                                    self.visibleChildName = pane.get()

                                    // a pane opens at its top: gtk scrolls
                                    // to whatever it decides to focus, which
                                    // landed the audio pane on its last
                                    // section with the rest above the fold.
                                    // Only while the popup is up: hide()
                                    // resets the pane right after win.hide(),
                                    // and touching an adjustment then forces
                                    // a re-layout that re-commits the layer
                                    // surface — the compositor keeps drawing
                                    // the last frame, which is the ghost pane
                                    // that stayed on screen after closing
                                    if (!win?.is_visible()) return
                                    for (const sw of paneScrollers)
                                        sw.get_vadjustment()?.set_value(0)
                                })
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
                                <SliderSection navigate={setPane} />
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
                                {/* airplane mode silences every radio:
                                it belongs above the networks it kills,
                                not as its own tile in the grid */}
                                <AirplaneModeRow />
                                <Gtk.ScrolledWindow
                                    $={self => paneScrollers.push(self)}
                                    vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
                                    hscrollbarPolicy={Gtk.PolicyType.NEVER}
                                    propagateNaturalHeight
                                    maxContentHeight={MAX_PANE_HEIGHT}
                                >
                                    <WifiWidget pane={pane} name="wifi" />
                                </Gtk.ScrolledWindow>
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
                                <Gtk.ScrolledWindow
                                    $={self => paneScrollers.push(self)}
                                    vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
                                    hscrollbarPolicy={Gtk.PolicyType.NEVER}
                                    propagateNaturalHeight
                                    maxContentHeight={MAX_PANE_HEIGHT}
                                >
                                    <BluetoothWidget pane={pane} name="bluetooth" />
                                </Gtk.ScrolledWindow>
                            </box>
                            {/* one pane per direction: a card's sink and
                            source share a description, so a combined
                            list read as two identical rows */}
                            <box
                                $type="named"
                                name="audioOutput"
                                orientation={Gtk.Orientation.VERTICAL}
                            >
                                <PaneHeader title="Output" onBack={() => setPane("main")} />
                                <Gtk.ScrolledWindow
                                    $={self => paneScrollers.push(self)}
                                    vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
                                    hscrollbarPolicy={Gtk.PolicyType.NEVER}
                                    propagateNaturalHeight
                                    maxContentHeight={MAX_PANE_HEIGHT}
                                >
                                    <AudioPane direction="output" pane={pane} name="audioOutput" />
                                </Gtk.ScrolledWindow>
                            </box>
                            <box
                                $type="named"
                                name="audioInput"
                                orientation={Gtk.Orientation.VERTICAL}
                            >
                                <PaneHeader title="Input" onBack={() => setPane("main")} />
                                <Gtk.ScrolledWindow
                                    $={self => paneScrollers.push(self)}
                                    vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
                                    hscrollbarPolicy={Gtk.PolicyType.NEVER}
                                    propagateNaturalHeight
                                    maxContentHeight={MAX_PANE_HEIGHT}
                                >
                                    <AudioPane direction="input" pane={pane} name="audioInput" />
                                </Gtk.ScrolledWindow>
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
                                    $={self => paneScrollers.push(self)}
                                    vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
                                    hscrollbarPolicy={Gtk.PolicyType.NEVER}
                                    propagateNaturalHeight
                                    maxContentHeight={MAX_PANE_HEIGHT}
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
