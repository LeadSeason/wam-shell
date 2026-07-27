import { execAsync } from "ags/process";
import Gtk from "gi://Gtk?version=4.0";
import SwayNc from "../../../lib/swayNC";
import { createBinding } from "gnim";
import Adw from "gi://Adw?version=1";

export default function Notify() {
    const swayNc = SwayNc.get_default();
    // swaync-client not installed: hide the widget entirely
    if (!swayNc.available) return <></>

    const handleClick = (e: Gtk.GestureClick) => {
        execAsync("swaync-client -t -sw")
    }
    const reveal = createBinding(swayNc, "count").as((v) => v > 0)
    const count = createBinding(swayNc, "count").as((v) => v.toString())
    const icon = createBinding(swayNc, "dnd").as(
        (v) => v ? "notifications-disabled-symbolic" : "preferences-system-notifications-symbolic"
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
            onPressed={handleClick}
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