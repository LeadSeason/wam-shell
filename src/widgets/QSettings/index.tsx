import Graphene from "gi://Graphene?version=1.0";
import GLib from "gi://GLib?version=2.0";

import { Astal, Gdk, Gtk } from "ags/gtk4";
import { timeout } from "ags/time";

import Tray from "./tray";
import Config from "../../config";
import CommandRegistry from "../../lib/requestHandler";

import { ToggleSection } from "./toggleSection";
import { HeaderSection } from "./HeaderSection";
import { SliderSection } from "./SliderSection";

const registry = CommandRegistry.get_default()


export default function QSettings() {
    const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor;
    let win: Astal.Window
    let contentBox: Gtk.Box
    let revealer: Gtk.Revealer
    const toggleSection = ToggleSection()

    function hide() {
        cancelClose()
        // For some reason it does'nt want to play the animation, Setting
        // timeout to 0 for this reason
        revealer.set_reveal_child(false)
        // give some time for the animation to play.
        timeout(50, () => {
            win.hide()
            toggleSection.reset()
        })
    }

    function show() {
        hasEntered = false
        cancelClose()
        win.present()
        revealer.set_reveal_child(true);
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
        }
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
        }
    })

    // close on ESC
    function onKey(
        _e: Gtk.EventControllerKey,
        keyValue: number,
        _: number,
        mod: number,
    ) {
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
        closeSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Config.qsettings.closeDelay, () => {
            closeSource = null
            if (win.is_visible()) hide()
            return GLib.SOURCE_REMOVE
        })
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
            x >= rx - BUFFER && x <= rx + width + BUFFER &&
            y >= ry - BUFFER && y <= ry + height + BUFFER

        if (inside) {
            hasEntered = true
            cancelClose()
        } else if (hasEntered) {
            scheduleClose()
        }
    }
    return <window
        $={(ref) => {
            win = ref
        }}
        name="QSettings"
        class="QSettings"
        namespace={`${Config.instanceName}QSettings`}

        anchor={TOP | BOTTOM | LEFT | RIGHT}
        keymode={Astal.Keymode.EXCLUSIVE}
    >

        <Gtk.EventControllerKey onKeyPressed={onKey} />
        <Gtk.GestureClick onPressed={onClick} />
        <Gtk.EventControllerMotion onMotion={onMotion} />
        <revealer
            $={(ref) => (revealer = ref)}
            transitionDuration={200}
            transition_type={Gtk.RevealerTransitionType.SLIDE_DOWN}
        >
            <box
                $={(ref) => (contentBox = ref)}
                valign={Gtk.Align.START}
                halign={Gtk.Align.END}
                orientation={Gtk.Orientation.VERTICAL}
                cssClasses={["qSettings"]}
                widthRequest={240}
            >
                <HeaderSection />
                {toggleSection.widget}
                <Gtk.Separator />
                <SliderSection />
                {!Config.tray.onPanel && <Gtk.Separator />}
                {!Config.tray.onPanel && <Tray />}
            </box>
        </revealer>
    </window>
}
