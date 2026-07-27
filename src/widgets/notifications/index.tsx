import { Astal, Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import Pango from "gi://Pango?version=1.0"
import Graphene from "gi://Graphene?version=1.0"
import { For } from "gnim"
import notifd, { dnd, toggleDnd } from "../../lib/notifd"
import { createBinding } from "gnim"
import CommandRegistry from "../../lib/requestHandler"

const registry = CommandRegistry.get_default()

function NotificationRow({ n }: { n: any }) {
    const image = n.get_image() || n.get_app_icon() || "application-x-executable-symbolic"
    return <box cssClasses={["notification"]} spacing={8}>
        <image iconName={image} pixelSize={24} valign={Gtk.Align.START} />
        <box orientation={Gtk.Orientation.VERTICAL} hexpand>
            <box>
                <label
                    cssClasses={["summary"]}
                    label={n.get_summary() || n.get_app_name()}
                    xalign={0} hexpand
                    maxWidthChars={28} ellipsize={Pango.EllipsizeMode.END}
                />
                <button cssClasses={["dismiss"]} onClicked={() => n.dismiss()}>
                    <image iconName="window-close-symbolic" />
                </button>
            </box>
            <label
                cssClasses={["body"]}
                label={n.get_body() || ""}
                xalign={0} wrap
                maxWidthChars={36}
                visible={n.get_body() !== ""}
            />
        </box>
    </box>
}

export default function Notifications() {
    const { TOP, RIGHT } = Astal.WindowAnchor
    let win: Astal.Window
    let rev: Gtk.Revealer
    let hideSource: number | null = null

    function show() {
        if (hideSource !== null) {
            GLib.source_remove(hideSource)
            hideSource = null
        }
        win.present()
        rev.revealChild = true
    }

    function hide() {
        rev.revealChild = false
        if (hideSource !== null) GLib.source_remove(hideSource)
        hideSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            hideSource = null
            win.hide()
            return GLib.SOURCE_REMOVE
        })
    }

    registry.register({
        name: ["notifications", "notificationCenter"],
        description: "Toggle the notification center",
        main: () => {
            if (!win) return "no window"
            if (win.is_visible()) {
                hide()
                return "hidden"
            }
            show()
            return "shown"
        }
    })

    const notifications = createBinding(notifd, "notifications")

    function onKey(_e: Gtk.EventControllerKey, keyValue: number) {
        if (keyValue === Gdk.KEY_Escape) hide()
    }

    function onClick(_e: Gtk.GestureClick, _: number, x: number, y: number) {
        const [, rect] = win.get_child()!.compute_bounds(win)
        if (!rect.contains_point(new Graphene.Point({ x, y }))) hide()
    }

    return <window
        $={(self) => { win = self }}
        name="Notifications"
        class="Notifications"
        namespace="notifications"
        anchor={TOP | RIGHT}
        marginTop={30}
        marginRight={12}
        keymode={Astal.Keymode.EXCLUSIVE}
        visible={false}
    >
        <Gtk.EventControllerKey onKeyPressed={onKey} />
        <Gtk.GestureClick onPressed={onClick} />
        <revealer
            $={(self) => { rev = self }}
            transitionDuration={200}
            transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
        >
            <box cssClasses={["notifications"]} orientation={Gtk.Orientation.VERTICAL} widthRequest={360}>
                <box cssClasses={["header"]}>
                    <label label="Notifications" xalign={0} hexpand />
                    <button
                        tooltipText="Do not disturb"
                        onClicked={() => toggleDnd()}
                    >
                        <image iconName={dnd.as(v => v
                            ? "notifications-disabled-symbolic"
                            : "preferences-system-notifications-symbolic")} />
                    </button>
                    <button
                        tooltipText="Clear all"
                        onClicked={() => {
                            for (const n of [...notifications.get()]) n.dismiss()
                        }}
                    >
                        <image iconName="user-trash-symbolic" />
                    </button>
                </box>
                <Gtk.Separator />
                <box
                    cssClasses={["empty"]}
                    visible={notifications.as(n => n.length === 0)}
                >
                    <label label="No notifications" />
                </box>
                <For each={notifications}>
                    {(n) => <NotificationRow n={n} />}
                </For>
            </box>
        </revealer>
    </window>
}
