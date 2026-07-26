import Sway, { Node } from "../lib/sway";
import { resolveNodeIcon } from "../lib/swayIcons";
import { capitalize } from "../lib/utils";

import { For, createBinding, createState } from "ags"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import Graphene from "gi://Graphene"
import Fuse from "fuse.js";
import { timeout } from "ags/time";
import Config from "../config";
import CommandRegistry from "../lib/requestHandler";

const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor


export default function Scratchpad() {
    let win: Astal.Window
    let contentBox: Gtk.Box
    let searchEntry: Gtk.Entry
    const [revealer, setReveler] = createState(false)
    let gtkIconTheme = new Gtk.IconTheme() // Will be replaced layer

    const sway = Sway.get_default()

    // This is a big assumption but haven't had any issues with it. (Just yet)
    // apps is the nodes in sway scratchpad, constantly being updated on every change.
    // list is has the apps show in the scratchpad window list, updated when opened or something is searched.
    const [apps, setApps] = createState(sway.scratchpadNodes)
    const [list, setList] = createState(sway.scratchpadNodes)

    createBinding(sway, "tree").subscribe(() => {
        setApps(sway.scratchpadNodes)
    })

    function search(text: string) {
        if (text.length < 1) {
            setList(apps.get())
            return
        }
        const fuse = new Fuse(apps.get(), {
            keys: [
                "name",
                "app_id",
                "window_properties.class",
                "window_properties.instance",
                "window_properties.title",
                "window_properties.window_role",
                "window_properties.window_type"
            ],
            threshold: 0.3,
            ignoreLocation: true,
            includeScore: true,
        })

        setList(fuse.search(text).map(result => result.item))
    }

    function openApp(app: Node) {
        sway.message_async(`[con_id=${app.id}] scratchpad show`)
        hide()
        return
    }

    // App entry, passed in a Sway Node (usually a window)
    function AppEntry({ app }: { app: Node }) {
        const icon = resolveNodeIcon(app, gtkIconTheme)
        const iconLet = icon ? <image iconName={icon} /> : <></>

        let title = ""
        let description = ""

        if (app.shell === "xwayland") {
            title = app.window_properties?.class ?? ""
            description = app.window_properties?.title ?? ""
        }
        else {
            title = app.app_id ?? ""
            description = app.name ?? ""
        }

        title = capitalize(title)
        description = capitalize(description)

        return <button onClicked={() => openApp(app)}>
            <box spacing={6}>
                {iconLet}
                <box orientation={Gtk.Orientation.VERTICAL}  >
                    <label label={title} class="title" maxWidthChars={60} wrap xalign={0} />
                    <label label={description} class="description" maxWidthChars={60} wrap xalign={0} />
                </box>
            </box>
        </button>
    }

    function showScratchpad(): [boolean, string] {
        if (win) {
            if (!win.is_visible()) {
                win.present()
                return [true, "Scratchpad, window show"]
            } else {
                hide()
                return [false, "Scratchpad, window hidden"]
            }
        }
        return [false, `Scratchpad, No window is defined, Maybe running on hyprland?
Scratchpad is sway-specific`]
    }

    const registry = CommandRegistry.get_default()

    registry.register({
        name: ["scratchpad", "showScratchpad"],
        description: "Show Apps/Nodes in the sway scratchpad",
        help: `Sway scratchpad Tool.
Lists apps / cons in the scratchpad.
Shows / hides the scratchpad tool on request.
    `,
        main: (argv: string[]) => {
            return showScratchpad()[1]
        }
    })
    function hide() {
        setReveler(false)
        // give some time for the animation to play.
        timeout(50, () => {
            win.hide()
        })
    }

    // close on ESC
    function onKey(
        _e: Gtk.EventControllerKey,
        keyValue: number,
        _: number,
        mod: number,
    ) {
        if (keyValue === Gdk.KEY_Escape) {
            hide()
            return
        }
    }

    // close on click away
    function onClick(_e: Gtk.GestureClick, _: number, x: number, y: number) {
        const [, rect] = contentBox.compute_bounds(win)
        const position = new Graphene.Point({ x, y })

        if (!rect.contains_point(position)) {
            hide()
            return
        }
    }

    return <window
        $={(ref) => {
            win = ref
            gtkIconTheme = Gtk.IconTheme.get_for_display(win.display)
        }}
        name="Scratchpad"
        class="Scratchpad"
        namespace={`${Config.instanceName}Scratchpad`}
        anchor={TOP | BOTTOM | LEFT | RIGHT}
        exclusivity={Astal.Exclusivity.IGNORE}
        keymode={Astal.Keymode.EXCLUSIVE}
        onNotifyVisible={({ visible }) => {
            if (visible) {
                setList(apps.get())
                searchEntry.grab_focus()
                setReveler(true)
            }
            else {
                searchEntry.set_text("")
            }
        }}
    >
        <Gtk.EventControllerKey onKeyPressed={onKey} />
        <Gtk.GestureClick onPressed={onClick} />
        <revealer
            transitionType={revealer.as((b) => b ? Gtk.RevealerTransitionType.SWING_DOWN : Gtk.RevealerTransitionType.SWING_UP)}
            transitionDuration={200}
            revealChild={revealer}
        >
            <box
                $={(ref) => (contentBox = ref)}
                name="launcher-content"
                valign={Gtk.Align.CENTER}
                halign={Gtk.Align.CENTER}
                orientation={Gtk.Orientation.VERTICAL}
            >
                <label class="title" label="Scratchpad" />
                <entry
                    $={(ref) => (searchEntry = ref)}
                    onNotifyText={({ text }) => search(text)}
                    onActivate={() => {
                        openApp(list.get()[0])
                    }}
                    placeholderText="Start typing to search"
                    primaryIconName={"system-search-symbolic"}
                />
                <Gtk.Separator />
                <box orientation={Gtk.Orientation.VERTICAL} spacing={6}>
                    <For each={list}>
                        {(app, index) => (
                            <AppEntry app={app} />
                        )}
                    </For>
                </box>
                <box
                    class="not-found"
                    valign={Gtk.Align.CENTER}
                    halign={Gtk.Align.CENTER}
                    orientation={Gtk.Orientation.VERTICAL}
                    visible={list((l) => l.length === 0)}
                >
                    <image iconName="system-search-symbolic" />
                    <label label="No match found" />
                </box>
            </box>
        </revealer>
    </window>
}