import { Astal, Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import Graphene from "gi://Graphene?version=1.0"
import app from "ags/gtk4/app"
import { For, With, createRoot, createState } from "gnim"
import notifd, { dnd, grouped, toggleDnd } from "../../lib/notifd"
import { createBinding } from "gnim"
import CommandRegistry from "../../lib/requestHandler"
import NotificationRow from "./NotificationRow"

const registry = CommandRegistry.get_default()

function Group({ app }: { app: string }) {
    // live view of this group's notifications; For keys groups by app so
    // this widget (and its expand state) survives list recomputes
    const items = grouped.as((gs) => gs.find((g) => g.app === app)?.items ?? [])
    const [expanded, setExpanded] = createState(false)
    const multi = items.as((l) => l.length > 1)

    return <box cssClasses={["group"]} orientation={Gtk.Orientation.VERTICAL} spacing={6}>
        <box cssClasses={["groupHeader"]} spacing={8} visible={multi}>
            <image
                iconName={items.as((l) => l[0]?.get_app_icon() || "application-x-executable-symbolic")}
                pixelSize={16}
            />
            <label cssClasses={["appName"]} label={app} xalign={0} />
            <label cssClasses={["count"]} label={items.as((l) => l.length.toString())} />
            <label hexpand />
            <button
                cssClasses={["expand"]}
                tooltipText={expanded.as((e) => e ? "Collapse" : "Expand")}
                onClicked={() => setExpanded(!expanded.get())}
            >
                <image iconName={expanded.as((e) => e ? "pan-up-symbolic" : "pan-down-symbolic")} />
            </button>
            <button
                cssClasses={["clearGroup"]}
                tooltipText="Clear group"
                onClicked={() => { for (const n of [...items.get()]) n.dismiss() }}
            >
                <image iconName="user-trash-symbolic" />
            </button>
        </box>
        {/* gnim can't nest Fragments, so expanded/collapsed are two
            containers toggled by visible rather than an accessor switch */}
        <box orientation={Gtk.Orientation.VERTICAL} spacing={6} visible={expanded}>
            <For each={items} id={(n) => n.id}>
                {(n) => <NotificationRow n={n} />}
            </For>
        </box>
        <box orientation={Gtk.Orientation.VERTICAL} visible={expanded.as((e) => !e)}>
            <With value={items.as((l) => l[0])}>
                {(n) => n && <NotificationRow n={n} />}
            </With>
        </box>
    </box>
}

// the request is registered eagerly (import side effect), but the
// window is built lazily on first toggle — no need to construct it
// at shell startup
let win: Astal.Window | null = null
let rev: Gtk.Revealer | null = null
let hideSource: number | null = null

function show() {
    if (hideSource !== null) {
        GLib.source_remove(hideSource)
        hideSource = null
    }
    win!.present()
    rev!.revealChild = true
}

function hide() {
    rev!.revealChild = false
    if (hideSource !== null) GLib.source_remove(hideSource)
    hideSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
        hideSource = null
        win!.hide()
        return GLib.SOURCE_REMOVE
    })
}

registry.register({
    name: ["notifications", "notificationCenter"],
    description: "Toggle the notification center",
    main: () => {
        ensureWindow()
        if (win!.is_visible()) {
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
    const [, rect] = win!.get_child()!.compute_bounds(win!)
    if (!rect.contains_point(new Graphene.Point({ x, y }))) hide()
}

function ensureWindow() {
    if (win) return
    const { TOP, RIGHT } = Astal.WindowAnchor
    createRoot(() => {
        app.add_window(<window
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
                    <Gtk.ScrolledWindow
                        vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
                        hscrollbarPolicy={Gtk.PolicyType.NEVER}
                        propagateNaturalHeight
                        maxContentHeight={640}
                    >
                        <box orientation={Gtk.Orientation.VERTICAL}>
                            <For each={grouped} id={(g) => g.app}>
                                {(g) => <Group app={g.app} />}
                            </For>
                        </box>
                    </Gtk.ScrolledWindow>
                </box>
            </revealer>
        </window> as Gtk.Window)
    })
}
