import { execAsync } from "ags/process";
import Gtk from "gi://Gtk?version=4.0";
import SwayNc from "../../../lib/swayNC";
import { createBinding } from "gnim";

export default function Notify() {
    const swayNc = SwayNc.get_default();

    const open = (e: Gtk.GestureClick) => {
        execAsync("swaync-client -t -sw")
    }

    const toggleDnd = (e: Gtk.GestureClick) => {
        execAsync("swaync-client -d -sw")
    }

    const reveal = createBinding(swayNc, "count").as((v) => v > 0)
    const count = createBinding(swayNc, "count").as((v) => v.toString())
    const icon = createBinding(swayNc, "dnd").as(
        (v) => v ? "notifications-disabled-symbolic" : "notifications-symbolic"
    )
    const badge = (<revealer
        transitionDuration={250}
        transitionType={Gtk.RevealerTransitionType.SWING_DOWN}
        revealChild={reveal}
        valign={Gtk.Align.START}
        halign={Gtk.Align.END}
        marginEnd={5}
    >
        <label
            hexpand={false}
            vexpand={false}
            class="Badge"
            label={count} />
    </revealer>) as Gtk.Box

    return <box cssClasses={["swayNC"]}>
        <Gtk.GestureClick
            button={1}
            onPressed={open}
        />
        <Gtk.GestureClick
            button={3}
            onPressed={toggleDnd}
        />
        <overlay
            $={(self) => {
                self.add_overlay(badge)
            }}
        >
            <image iconName={icon} />
        </overlay>
    </box>
}