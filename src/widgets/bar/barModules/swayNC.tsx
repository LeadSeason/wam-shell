import { Gtk } from "ags/gtk4"
import { dnd } from "../../../lib/notifd"
import CommandRegistry from "../../../lib/requestHandler"

const registry = CommandRegistry.get_default()

// the panel shows only the bell: pending counts live inside the
// notification center (filter row), not on the panel
export default function Notify() {
    const icon = dnd.as(v =>
        v ? "notifications-disabled-symbolic" : "preferences-system-notifications-symbolic",
    )

    return (
        <box cssClasses={["swayNC"]}>
            <Gtk.GestureClick
                button={1}
                onPressed={() => {
                    registry.execute(["notifications"], true)
                }}
            />
            <image iconName={icon} />
        </box>
    )
}
