import { Astal, Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import Graphene from "gi://Graphene?version=1.0"
import app from "ags/gtk4/app"
import { For, createComputed, createRoot, createState } from "gnim"
import notifd, { dnd, persistent, toggleDnd } from "../../lib/notifd"
import { createBinding } from "gnim"
import CommandRegistry from "../../lib/requestHandler"
import { timeoutAdd, sourceRemove } from "../../lib/metrics"
import { hideOnFocusLoss } from "../../lib/popupFocus"
import NotificationCard from "./NotificationCard"

const registry = CommandRegistry.get_default()

// the request is registered eagerly (import side effect), but the
// window is built lazily on first toggle — no need to construct it
// at shell startup
let win: Astal.Window | null = null
let rev: Gtk.Revealer | null = null
let card: Gtk.Box | null = null
let searchEntry: Gtk.Entry | null = null
let hideSource: number | null = null

function show() {
    if (hideSource !== null) {
        sourceRemove(hideSource)
        hideSource = null
    }
    win!.present()
    rev!.revealChild = true
    searchEntry?.grab_focus()
}

function hide() {
    setQuery("")
    rev!.revealChild = false
    if (hideSource !== null) sourceRemove(hideSource)
    hideSource = timeoutAdd("notifCenter:hide", GLib.PRIORITY_DEFAULT, 200, () => {
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
    },
})

const notifications = createBinding(notifd, "notifications")
// flat list of the center's history (transient-hinted and filtered apps
// excluded), newest first (ties broken by id: notifications sent within
// the same second still order by arrival)
const sorted = persistent.as(list => [...list].sort((a, b) => b.time - a.time || b.id - a.id))

// header filter: case-insensitive substring match on the app name.
// createComputed over both inputs: sorted.as alone would not recompute
// when the query changes
const [query, setQuery] = createState("")
const filtered = createComputed([sorted, query], (list, q) => {
    const needle = q.trim().toLowerCase()
    return needle === "" ? list : list.filter(n => (n.appName || "").toLowerCase().includes(needle))
})

function onKey(_e: Gtk.EventControllerKey, keyValue: number) {
    if (keyValue === Gdk.KEY_Escape) hide()
}

function onClick(_e: Gtk.GestureClick, _: number, x: number, y: number) {
    // the overlay is fullscreen; only clicks outside the card close it
    const [, rect] = card!.compute_bounds(win!)
    if (!rect.contains_point(new Graphene.Point({ x, y }))) hide()
}

function ensureWindow() {
    if (win) return
    const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor
    createRoot(() => {
        app.add_window(
            (
                <window
                    $={self => {
                        win = self
                        hideOnFocusLoss(win, hide)
                    }}
                    name="Notifications"
                    class="Notifications"
                    namespace="notifications"
                    // fullscreen overlay (QSettings/harvest pattern): an
                    // edge-anchored window grows with the list but never
                    // shrinks back — the card inside clamps to content
                    anchor={TOP | BOTTOM | LEFT | RIGHT}
                    // ON_DEMAND, not EXCLUSIVE: the grab stole input from
                    // other surfaces; focus loss closes instead
                    keymode={Astal.Keymode.ON_DEMAND}
                    visible={false}
                >
                    <Gtk.EventControllerKey onKeyPressed={onKey} />
                    <Gtk.GestureClick onPressed={onClick} />
                    <box halign={Gtk.Align.END} valign={Gtk.Align.START}>
                        <revealer
                            $={self => {
                                rev = self
                            }}
                            transitionDuration={200}
                            transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
                        >
                            <box
                                $={self => {
                                    card = self
                                }}
                                cssClasses={["notifications"]}
                                orientation={Gtk.Orientation.VERTICAL}
                                widthRequest={380}
                                marginTop={30}
                                marginEnd={12}
                            >
                                <box cssClasses={["header"]} spacing={6}>
                                    <entry
                                        $={self => {
                                            searchEntry = self
                                        }}
                                        cssClasses={["filter"]}
                                        placeholderText="Filter by app…"
                                        hexpand
                                        onChanged={self => setQuery(self.text)}
                                    />
                                    <button
                                        tooltipText="Do not disturb"
                                        onClicked={() => toggleDnd()}
                                    >
                                        <image
                                            iconName={dnd.as(v =>
                                                v
                                                    ? "notifications-disabled-symbolic"
                                                    : "preferences-system-notifications-symbolic",
                                            )}
                                        />
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
                                    visible={filtered.as(l => l.length === 0)}
                                >
                                    <label
                                        label={query.as(q =>
                                            q.trim() === "" ? "No notifications" : "No matches",
                                        )}
                                    />
                                </box>
                                <Gtk.ScrolledWindow
                                    vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
                                    hscrollbarPolicy={Gtk.PolicyType.NEVER}
                                    propagateNaturalHeight
                                    maxContentHeight={640}
                                    visible={filtered.as(l => l.length > 0)}
                                >
                                    <box
                                        cssClasses={["list"]}
                                        orientation={Gtk.Orientation.VERTICAL}
                                        spacing={8}
                                    >
                                        <For each={filtered} id={n => n.id}>
                                            {n => (
                                                <NotificationCard
                                                    n={n}
                                                    onDismiss={() => n.dismiss()}
                                                />
                                            )}
                                        </For>
                                    </box>
                                </Gtk.ScrolledWindow>
                            </box>
                        </revealer>
                    </box>
                </window>
            ) as Gtk.Window,
        )
    })
}
