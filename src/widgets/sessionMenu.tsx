import { Astal, Gdk, Gtk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import Graphene from "gi://Graphene?version=1.0"
import app from "ags/gtk4/app"
import { createRoot, createState } from "gnim"
import CommandRegistry from "../lib/requestHandler"
import { hideOnFocusLoss } from "../lib/popupFocus"
import { registerPopup, closeOtherPopups } from "../lib/exclusivePopups"
import { execAsync, timeoutAdd, sourceRemove } from "../lib/metrics"
import { confirmDialog } from "./dialog"

// The session menu: everything that ends the session, in one place.
//
// Quick settings used to carry three icon buttons in its header — lock,
// log out, shut down — and that was the whole set. Suspend, hibernate
// and reboot did not exist anywhere in the shell, which is a strange
// gap for a laptop shell: the action you reach for most is the one that
// was missing.
//
// Not a pane inside quick settings, because it is not a setting. It is
// a decision, it wants the keyboard, and it wants to be reachable from
// a keybind without opening a panel first.

const registry = CommandRegistry.get_default()

interface Action {
    id: string
    label: string
    icon: string
    /** confirm first: this one loses unsaved work */
    confirm?: { text: string; subtext: string; yes: string }
    run: () => void
}

// loginctl needs the session id; the compositor's own locker answers the
// Lock signal. Empty when not under systemd-logind, which is also the
// only case where the session actions cannot work at all.
const sessionId = GLib.getenv("XDG_SESSION_ID") ?? ""

function loginctl(...args: string[]) {
    if (!sessionId) {
        console.warn("sessionMenu: no XDG_SESSION_ID, not under logind")
        return
    }
    execAsync(["loginctl", ...args, sessionId]).catch(e => console.warn(`loginctl ${args}:`, e))
}

function systemctl(verb: string) {
    execAsync(["systemctl", verb]).catch(e => console.warn(`systemctl ${verb}:`, e))
}

const ACTIONS: Action[] = [
    {
        id: "lock",
        label: "Lock",
        icon: "system-lock-screen-symbolic",
        run: () => loginctl("lock-session"),
    },
    {
        id: "suspend",
        label: "Suspend",
        icon: "weather-clear-night-symbolic",
        run: () => systemctl("suspend"),
    },
    {
        id: "hibernate",
        label: "Hibernate",
        icon: "system-hibernate-symbolic",
        run: () => systemctl("hibernate"),
    },
    {
        id: "logout",
        label: "Log out",
        icon: "system-log-out-symbolic",
        confirm: {
            text: "Log out?",
            subtext: "Ends the current session",
            yes: "Log out",
        },
        run: () => loginctl("terminate-session"),
    },
    {
        id: "reboot",
        label: "Restart",
        icon: "system-reboot-symbolic",
        confirm: {
            text: "Restart?",
            subtext: "Closes everything and reboots the machine",
            yes: "Restart",
        },
        run: () => systemctl("reboot"),
    },
    {
        id: "poweroff",
        label: "Shut down",
        icon: "system-shutdown-symbolic",
        confirm: {
            text: "Shut down?",
            subtext: "Powers off the machine",
            yes: "Shut down",
        },
        run: () => systemctl("poweroff"),
    },
]

// Which of these the machine can actually do.
//
// A greyed-out Hibernate on a machine with no resume-capable swap is a
// button that exists to say no; logind already knows, so ask it. The
// answer is one of yes/no/na/challenge — "challenge" means it would
// prompt for authentication, which is still a usable action, so only a
// flat no or na hides the tile.
const [available, setAvailable] = createState<Record<string, boolean>>({})

function probeCapabilities() {
    const ask = (method: string, id: string) => {
        Gio.DBus.system.call(
            "org.freedesktop.login1",
            "/org/freedesktop/login1",
            "org.freedesktop.login1.Manager",
            method,
            null,
            new GLib.VariantType("(s)"),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (conn, res) => {
                try {
                    const reply = conn!.call_finish(res)
                    const answer = reply.deepUnpack<string[]>()[0] ?? "no"
                    setAvailable({ ...available.get(), [id]: answer !== "no" && answer !== "na" })
                } catch (e) {
                    // logind unreachable: leave the tile hidden rather
                    // than offering an action that cannot land
                    console.warn(`sessionMenu: ${method} failed:`, e)
                    setAvailable({ ...available.get(), [id]: false })
                }
            },
        )
    }
    ask("CanSuspend", "suspend")
    ask("CanHibernate", "hibernate")
}

// everything not probed is always offered: lock, log out, reboot and
// poweroff are available wherever logind is, and gating them on a probe
// would leave the menu empty for the moment before it answers
function isAvailable(id: string, probed: Record<string, boolean>): boolean {
    if (id !== "suspend" && id !== "hibernate") return true
    return probed[id] === true
}

let win: Astal.Window | null = null
let card: Gtk.Box | null = null
let rev: Gtk.Revealer | null = null
let hideSource: number | null = null
let firstButton: Gtk.Widget | null = null

registerPopup("session", () => {
    if (win?.is_visible()) hide()
})

function show() {
    closeOtherPopups("session")
    if (hideSource !== null) {
        sourceRemove(hideSource)
        hideSource = null
    }
    probeCapabilities()
    win!.present()
    rev!.revealChild = true
    // Focus the LEAST destructive action, and do it on every open.
    // Enter is the reflex right after a keybind, so whatever is focused
    // when the menu appears is what an impatient user runs — that has to
    // be Lock, never whatever they happened to pick last time.
    firstButton?.grab_focus()
}

function hide() {
    if (!win) return
    rev!.revealChild = false
    if (hideSource !== null) sourceRemove(hideSource)
    hideSource = timeoutAdd("sessionMenu:hide", GLib.PRIORITY_DEFAULT, 200, () => {
        hideSource = null
        win!.hide()
        return GLib.SOURCE_REMOVE
    })
}

async function activate(action: Action) {
    // The menu goes away first either way. With a confirmation it has
    // to: the dialog is its own window, so leaving the menu up would
    // take focus off it and trip the focus-loss watcher anyway — and
    // two stacked surfaces asking about the same thing is one too many.
    hide()
    if (action.confirm) {
        const ok = await confirmDialog({
            text: action.confirm.text,
            subtext: action.confirm.subtext,
            yesButton: action.confirm.yes,
        })
        if (!ok) return
    }
    action.run()
}

function onKey(_e: Gtk.EventControllerKey, keyValue: number) {
    if (keyValue === Gdk.KEY_Escape) {
        hide()
        return true
    }
    // Arrows move between the tiles. GTK's own arrow navigation inside a
    // plain box is not something to rely on, and this menu is meant to
    // be driven entirely from the keyboard.
    const dir =
        keyValue === Gdk.KEY_Left || keyValue === Gdk.KEY_Up
            ? Gtk.DirectionType.TAB_BACKWARD
            : keyValue === Gdk.KEY_Right || keyValue === Gdk.KEY_Down
              ? Gtk.DirectionType.TAB_FORWARD
              : null
    if (dir === null) return false
    win!.child_focus(dir)
    return true
}

function onClick(_e: Gtk.GestureClick, _: number, x: number, y: number) {
    // fullscreen overlay: only clicks outside the card close it
    const [, rect] = card!.compute_bounds(win!)
    if (!rect.contains_point(new Graphene.Point({ x, y }))) hide()
}

function Tile(action: Action, index: number) {
    return (
        <button
            cssClasses={["sessionTile", `session-${action.id}`]}
            visible={available.as(probed => isAvailable(action.id, probed))}
            tooltipText={action.label}
            onClicked={() => void activate(action)}
            $={self => {
                if (index === 0) firstButton = self as Gtk.Widget
            }}
        >
            <box orientation={Gtk.Orientation.VERTICAL} spacing={6}>
                <image iconName={action.icon} pixelSize={32} halign={Gtk.Align.CENTER} />
                <label label={action.label} />
            </box>
        </button>
    )
}

function ensureWindow() {
    if (win) return
    createRoot(() => {
        app.add_window(
            (
                <window
                    $={self => {
                        win = self
                        hideOnFocusLoss(win, hide)
                    }}
                    name="SessionMenu"
                    class="SessionMenu"
                    namespace="session-menu"
                    anchor={
                        Astal.WindowAnchor.TOP |
                        Astal.WindowAnchor.BOTTOM |
                        Astal.WindowAnchor.LEFT |
                        Astal.WindowAnchor.RIGHT
                    }
                    // ON_DEMAND like every other popup here: EXCLUSIVE
                    // grabs the whole seat. The menu still gets the
                    // keyboard because it is presented and focused.
                    keymode={Astal.Keymode.ON_DEMAND}
                    visible={false}
                >
                    <Gtk.EventControllerKey onKeyPressed={onKey} />
                    <Gtk.GestureClick onPressed={onClick} />
                    <revealer
                        $={self => {
                            rev = self
                        }}
                        hexpand
                        vexpand
                        transitionDuration={200}
                        transitionType={Gtk.RevealerTransitionType.CROSSFADE}
                    >
                        {/* The scrim is a BOX filling the surface, not
                        the window's own background. A layer-shell window
                        gets its size from the compositor, but GTK still
                        allocates its content by natural size — so a
                        background on the window node painted a
                        full-width band the height of the card and left
                        the rest of the screen undimmed. An expanding
                        child is what actually covers the surface, and it
                        has the side benefit of fading in with the card
                        instead of snapping on ahead of it. */}
                        <box
                            cssClasses={["sessionScrim"]}
                            hexpand
                            vexpand
                            valign={Gtk.Align.FILL}
                            halign={Gtk.Align.FILL}
                        >
                            <box
                                cssClasses={["sessionCard"]}
                                orientation={Gtk.Orientation.VERTICAL}
                                spacing={12}
                                // hexpand AND halign: the scrim is a
                                // horizontal box, which hands a
                                // non-expanding child its natural width
                                // at the start edge — halign alone
                                // centres the card inside a cell that is
                                // already only as wide as the card, so
                                // it stays pinned to the left
                                hexpand
                                valign={Gtk.Align.CENTER}
                                halign={Gtk.Align.CENTER}
                                $={self => {
                                    card = self as Gtk.Box
                                }}
                            >
                                <label cssClasses={["sessionTitle"]} label={"Session"} />
                                <box cssClasses={["sessionTiles"]} spacing={8} homogeneous>
                                    {ACTIONS.map((a, i) => Tile(a, i))}
                                </box>
                            </box>
                        </box>
                    </revealer>
                </window>
            ) as Gtk.Window,
        )
    })
}

registry.register({
    name: ["session", "power-menu", "powermenu"],
    description: "Toggle the session menu (lock, suspend, log out, restart, shut down)",
    help: `session
  Toggles the menu.
session <action>
  Runs one directly, skipping the menu but NOT the confirmation:
  ${ACTIONS.map(a => a.id).join(", ")}`,
    main: args => {
        const arg = args[0] ?? ""
        if (arg) {
            const action = ACTIONS.find(a => a.id === arg)
            if (!action)
                return `unknown action "${arg}" (expected one of: ${ACTIONS.map(a => a.id).join(", ")})`
            void activate(action)
            return `running ${action.id}`
        }
        ensureWindow()
        if (win!.is_visible()) {
            hide()
            return "hidden"
        }
        show()
        return "shown"
    },
})
