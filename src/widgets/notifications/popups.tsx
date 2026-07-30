import { Astal, Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import { createBinding, createComputed, For } from "gnim"
import AstalHyprland from "gi://AstalHyprland"
import Config from "../../config"
import Sway from "../../lib/sway"
import { popups } from "../../lib/notifd"
import PopupRow from "./PopupRow"

// Transient notification banners. One window per monitor; content only
// shows on the focused monitor (same focus-follow pattern as the OSD).
export default function NotificationPopups({ gdkMonitor }: { gdkMonitor: Gdk.Monitor }) {
    const { TOP, RIGHT } = Astal.WindowAnchor

    const position = Config.notifications.position
    const anchor = position === "topCenter" ? TOP : TOP | RIGHT
    // 38px bar + gap: the pill's top edge used to overlap the bar by
    // 4px, and hovering it flapped between bar and banner hover areas
    const margins =
        position === "topCenter" ? { marginTop: 42 } : { marginTop: 42, marginRight: 12 }

    let isFocused
    if (Config.desktopSession === "hyprland") {
        const hyprland = AstalHyprland.get_default()
        isFocused = createBinding(hyprland, "focusedMonitor").as(
            m => m?.name === gdkMonitor.get_connector(),
        )
    } else if (Config.desktopSession === "sway" || Config.desktopSession === "i3") {
        const sway = Sway.get_default()
        isFocused = sway.ok
            ? createBinding(sway, "outputs").as(
                  outputs =>
                      (outputs.find((o: any) => o.focused)?.name ?? null) ===
                      gdkMonitor.get_connector(),
              )
            : createBinding(app, "monitors").as(ms => ms[0] === gdkMonitor)
    } else {
        isFocused = createBinding(app, "monitors").as(ms => ms[0] === gdkMonitor)
    }

    // hidden window => no layer surface: an always-mapped empty window
    // still claims a 200x200 input region at the anchor point
    const visible = createComputed(
        [popups, isFocused],
        (list, focused) => list.length > 0 && focused,
    )

    // rows exist only on the focused window: every window builds rows
    // from the same shared list, and each PopupRow owns a countdown —
    // an unfocused window's copy would keep draining (it can't be
    // hovered) and expire the popup out from under the user
    const rows = createComputed([popups, isFocused], (list, focused) => (focused ? list : []))

    return (
        <window
            name="NotificationPopups"
            class="NotificationPopups"
            namespace="notification-popups"
            gdkmonitor={gdkMonitor}
            anchor={anchor}
            {...margins}
            layer={Astal.Layer.TOP}
            keymode={Astal.Keymode.NONE}
            visible={visible}
        >
            <box cssClasses={["popups"]} orientation={Gtk.Orientation.VERTICAL} spacing={8}>
                <For each={rows} id={n => n.id}>
                    {n => <PopupRow n={n} />}
                </For>
            </box>
        </window>
    )
}
