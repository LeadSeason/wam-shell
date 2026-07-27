import Gtk from "gi://Gtk?version=4.0";
import { count, dnd } from "../../../lib/notifd";
import CommandRegistry from "../../../lib/requestHandler";

const registry = CommandRegistry.get_default()

export default function Notify() {
    const reveal = count.as((v) => v > 0)
    const countText = count.as((v) => v.toString())
    const icon = dnd.as(
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
            label={countText} />
    </revealer>) as Gtk.Box

    return <box cssClasses={["swayNC"]}>
        <Gtk.GestureClick
            button={1}
            onPressed={() => { registry.execute(["notifications"], true) }}
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
