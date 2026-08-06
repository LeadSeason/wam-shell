import { Gtk } from "ags/gtk4"
import { count, dnd } from "../../../lib/notifd"
import CommandRegistry from "../../../lib/requestHandler"

const registry = CommandRegistry.get_default()

// The panel bell, with a count of what is waiting.
//
// The count is the LOCAL daemon's, not a total across the providers.
// Two reasons: the providers each keep their own chip and count inside
// the center, so a single number on the panel would be answering a
// question nobody asked; and summing them here is not actually
// available — this widget is built at startup, before the provider
// modules have registered, so a computed over the registry would close
// over an empty list forever (the same trap the center works around by
// building its window lazily).
export default function Notify() {
    const icon = dnd.as(v =>
        v ? "notifications-disabled-symbolic" : "preferences-system-notifications-symbolic",
    )

    return (
        <box cssClasses={["swayNC"]} spacing={4}>
            <Gtk.GestureClick
                button={1}
                onPressed={() => {
                    registry.execute(["notifications"], true)
                }}
            />
            <image iconName={icon} />
            {/* hidden at zero rather than showing a "0": an empty inbox
                should look like an empty bell, not like a readout */}
            <label
                cssClasses={["Badge"]}
                label={count.as(n => String(n))}
                visible={count.as(n => n > 0)}
                // without this the label fills the box's full height and
                // the pill stretches the whole depth of the bar; centred,
                // it hugs its own text
                valign={Gtk.Align.CENTER}
            />
        </box>
    )
}
