import Graphene from "gi://Graphene?version=1.0";

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

    function hide() {
        // For some reason it does'nt want to play the animation, Setting
        // timeout to 0 for this reason
        revealer.set_reveal_child(false)
        // give some time for the animation to play.
        timeout(50, () => {
            win.hide()
        })
    }

    function show() {
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
    }})

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
                <ToggleSection />
                <Gtk.Separator />
                <SliderSection />
                <Gtk.Separator />
                <Tray />
            </box>
        </revealer>
    </window>
}
