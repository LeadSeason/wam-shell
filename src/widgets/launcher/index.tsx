import { Astal, Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import Pango from "gi://Pango?version=1.0"
import Graphene from "gi://Graphene?version=1.0"
import AstalApps from "gi://AstalApps"
import { createState, For } from "gnim"
import CommandRegistry from "../../lib/requestHandler"

const registry = CommandRegistry.get_default()
const apps = new AstalApps.Apps()

export default function Launcher() {
    let win: Astal.Window
    let entry: Gtk.Entry
    let hideSource: number | null = null

    const [text, setText] = createState("")
    const list = text.as(t => apps.fuzzy_query(t).slice(0, 8))

    function launch(app: any) {
        app.launch()
        hide()
    }

    function show() {
        if (hideSource !== null) {
            GLib.source_remove(hideSource)
            hideSource = null
        }
        setText("")
        entry.set_text("")
        win.present()
        entry.grab_focus()
    }

    function hide() {
        win.hide()
    }

    registry.register({
        name: ["launcher", "launch"],
        description: "Toggle the app launcher",
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

    function onKey(_e: Gtk.EventControllerKey, keyValue: number) {
        if (keyValue === Gdk.KEY_Escape) hide()
    }

    function onClick(_e: Gtk.GestureClick, _: number, x: number, y: number) {
        const [, rect] = win.get_child()!.compute_bounds(win)
        if (!rect.contains_point(new Graphene.Point({ x, y }))) hide()
    }

    return <window
        $={(self) => { win = self }}
        name="Launcher"
        class="Launcher"
        namespace="launcher"
        keymode={Astal.Keymode.EXCLUSIVE}
        layer={Astal.Layer.OVERLAY}
        visible={false}
    >
        <Gtk.EventControllerKey onKeyPressed={onKey} />
        <Gtk.GestureClick onPressed={onClick} />
        <box
            cssClasses={["launcher"]}
            orientation={Gtk.Orientation.VERTICAL}
            widthRequest={420}
            valign={Gtk.Align.CENTER}
            halign={Gtk.Align.CENTER}
        >
            <entry
                $={(self) => { entry = self }}
                cssClasses={["search"]}
                placeholderText="Search applications…"
                onChanged={(self) => setText(self.get_text())}
                onActivate={() => {
                    const first = list.get()[0]
                    if (first) launch(first)
                }}
            />
            <For each={list}>
                {(app) => (
                    <box cssName="button" cssClasses={["appRow"]} spacing={10}>
                        <Gtk.GestureClick
                            button={1}
                            onPressed={() => launch(app)}
                        />
                        <image iconName={app.get_icon_name() || "application-x-executable-symbolic"} pixelSize={24} />
                        <label
                            label={app.get_name()}
                            xalign={0} hexpand
                            maxWidthChars={30} ellipsize={Pango.EllipsizeMode.END}
                        />
                    </box>
                )}
            </For>
        </box>
    </window>
}
