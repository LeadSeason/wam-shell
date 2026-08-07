import { Gtk } from "ags/gtk4"
import { createComputed } from "gnim"
import { count, dnd } from "../../../lib/notifd"
import { providers } from "../../../lib/notificationProviders"
import type { ProviderItem } from "../../../lib/notificationProviders"
import CommandRegistry from "../../../lib/requestHandler"

const registry = CommandRegistry.get_default()

// The panel bell, with a count of everything waiting in the centre — the
// local daemon's notifications plus every provider's items. A bell
// reading "2" while the centre holds thirty-four is not a summary of
// anything.
//
// The total is built HERE, inside the component, and that is the whole
// trick. Providers register when app.tsx imports them; the bar is
// constructed later, inside app.start(). By the time this function runs
// the registry is final — verified rather than assumed: four providers
// were present at bar build. A computed spread at MODULE scope would
// close over an empty list forever, which is the trap the centre avoids
// by building its window lazily, and the reason this widget first
// shipped counting the local daemon alone.
export default function Notify() {
    const icon = dnd.as(v =>
        v ? "notifications-disabled-symbolic" : "preferences-system-notifications-symbolic",
    )

    // muted providers still count: muting stops their banners, it does
    // not mean their items stopped waiting in the centre
    const total = createComputed([count, ...providers.map(p => p.items)], (local, ...lists) =>
        lists.reduce((n: number, l) => n + ((l as ProviderItem[])?.length ?? 0), local as number),
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
                label={total.as(n => String(n))}
                visible={total.as(n => n > 0)}
                // without this the label fills the box's full height and
                // the pill stretches the whole depth of the bar; centred,
                // it hugs its own text
                valign={Gtk.Align.CENTER}
            />
        </box>
    )
}
