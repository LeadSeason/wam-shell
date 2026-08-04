import { Astal, Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import Graphene from "gi://Graphene?version=1.0"
import app from "ags/gtk4/app"
import { createRoot, createState } from "gnim"
import CommandRegistry from "../lib/requestHandler"
import { timeoutAdd, sourceRemove } from "../lib/metrics"
import { hideOnFocusLoss } from "../lib/popupFocus"
import { monitorAlive } from "../lib/utils"
import * as Harvest from "../lib/harvest"
import Config from "../config"
import { RunningHeader } from "./harvest/running"
import { NewEntryForm } from "./harvest/newEntry"
import { PausedCard } from "./harvest/paused"
import { Timeline } from "./harvest/timeline"

// Harvest picker popup: drops below the panel pill (mediaPopup pattern).
// Left-click the pill to toggle, right-click for quick stop/resume.
// User-invoked, so entry details are never masked here.
//
// The sections live under ./harvest/: running header, paused card, day
// timeline and the new-entry form; this file keeps the window shell

const registry = CommandRegistry.get_default()

/** where the pill was clicked: the popup drops directly below it */
export const [popupAnchor, setPopupAnchor] = createState<{
    x: number
    monitor: Gdk.Monitor
} | null>(null)

// the popup appears where the pill is: centered for the center section,
// left/right for the side sections
function fallbackAlign(): Gtk.Align {
    const zones = new Set<string>()
    for (const p of Config.panels) {
        if (p.left.includes("harvest")) zones.add("left")
        if (p.center.includes("harvest")) zones.add("center")
        if (p.right.includes("harvest")) zones.add("right")
    }
    if (zones.has("center")) return Gtk.Align.CENTER
    if (zones.has("left") && !zones.has("right")) return Gtk.Align.START
    if (zones.has("right") && !zones.has("left")) return Gtk.Align.END
    return zones.size === 0 ? Gtk.Align.END : Gtk.Align.CENTER
}

function Footer({ onNewEntry }: { onNewEntry: () => void }) {
    return (
        <box cssClasses={["footer"]}>
            {/* only the number is emphasized, "Today:" stays dim */}
            <box hexpand spacing={4}>
                <label cssClasses={["elapsed", "dim"]} xalign={0} label={"Today:"} />
                <label
                    cssClasses={["elapsed", "dim", "total"]}
                    xalign={0}
                    label={Harvest.dayTotal.as(t => Harvest.formatElapsed(t))}
                />
            </box>
            <button cssClasses={["newEntry"]} onClicked={onNewEntry}>
                <label label={"+ New entry"} />
            </button>
        </box>
    )
}

function PopupContent() {
    // running section always built and visibility-toggled, never lazily
    // inserted: a <With> child created when the timer starts would be
    // re-appended *below* the idle content instead of taking the top
    const [formOpen, setFormOpen] = createState(false)

    return (
        <box
            cssClasses={["harvestPopup"]}
            orientation={Gtk.Orientation.VERTICAL}
            spacing={12}
            widthRequest={480}
        >
            <box
                orientation={Gtk.Orientation.VERTICAL}
                spacing={10}
                visible={Harvest.running.as(r => r !== null)}
            >
                <RunningHeader />
                <Gtk.Separator />
            </box>
            <PausedCard />
            <Timeline />
            <Footer onNewEntry={() => setFormOpen(!formOpen.get())} />
            <revealer revealChild={formOpen}>
                <NewEntryForm onCancel={() => setFormOpen(false)} />
            </revealer>
        </box>
    )
}

// the request is registered eagerly (import side effect), but the
// window is built lazily on first toggle — no need to construct it
// at shell startup
let win: Astal.Window | null = null
let rev: Gtk.Revealer | null = null
let hideSource: number | null = null

function show() {
    if (hideSource !== null) {
        sourceRemove(hideSource)
        hideSource = null
    }
    // stale-while-revalidate the near-static data on open
    Harvest.refreshSlow()
    // and sync anything that changed since the last tick right now
    Harvest.deltaPoll()
    const anchor = popupAnchor.get()
    // the monitor the anchor was captured on may be gone (hotplug):
    // assigning a removed output maps the window into the void
    if (anchor && monitorAlive(anchor.monitor)) win!.gdkmonitor = anchor.monitor
    win!.present()
    rev!.revealChild = true
}

// pill-centered, but never past the monitor's right edge
function popupMarginLeft(): number {
    const anchor = popupAnchor.get()
    if (!anchor) return 12
    // window width: 480 request + horizontal margins
    const POPUP_W = 480 + 24
    const monW = anchor.monitor.get_geometry().width
    return Math.max(0, Math.min(Math.round(anchor.x - POPUP_W / 2), monW - POPUP_W))
}

function hide() {
    rev!.revealChild = false
    if (hideSource !== null) sourceRemove(hideSource)
    hideSource = timeoutAdd("harvestPopup:hide", GLib.PRIORITY_DEFAULT, 200, () => {
        hideSource = null
        win!.hide()
        return GLib.SOURCE_REMOVE
    })
}

registry.register({
    name: ["harvest", "harvestPopup"],
    description: "Toggle the Harvest timer popup",
    main: () => {
        if (!Harvest.active) return "Harvest is not configured"
        ensureWindow()
        if (win!.is_visible()) {
            hide()
            return "hidden"
        }
        show()
        return "shown"
    },
})

function onKey(_e: Gtk.EventControllerKey, keyValue: number) {
    if (keyValue === Gdk.KEY_Escape) hide()
}

function onClick(_e: Gtk.GestureClick, _: number, x: number, y: number) {
    // the overlay is fullscreen; only clicks outside the card close it
    const [, rect] = card!.compute_bounds(win!)
    if (!rect.contains_point(new Graphene.Point({ x, y }))) hide()
}

// fullscreen overlay with the card positioned inside (QSettings
// pattern): an edge-anchored window grows with the inline selectors
// but never shrinks back
let card: Gtk.Box | null = null

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
                    name="HarvestPopup"
                    class="HarvestPopup"
                    namespace="harvest-popup"
                    anchor={
                        Astal.WindowAnchor.TOP |
                        Astal.WindowAnchor.BOTTOM |
                        Astal.WindowAnchor.LEFT |
                        Astal.WindowAnchor.RIGHT
                    }
                    // ON_DEMAND, not EXCLUSIVE: popovers (entry context
                    // menu, emoji picker) cannot grab the seat under
                    // EXCLUSIVE. Focus loss closes the window (popupFocus)
                    keymode={Astal.Keymode.ON_DEMAND}
                    visible={false}
                >
                    <Gtk.EventControllerKey onKeyPressed={onKey} />
                    <Gtk.GestureClick onPressed={onClick} />
                    <revealer
                        $={self => {
                            rev = self
                        }}
                        transitionDuration={200}
                        transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
                    >
                        <box
                            valign={Gtk.Align.START}
                            halign={popupAnchor.as(a => (a ? Gtk.Align.START : fallbackAlign()))}
                            marginTop={30}
                            marginStart={popupAnchor.as(() => popupMarginLeft())}
                            marginEnd={12}
                        >
                            <box
                                $={self => {
                                    card = self
                                }}
                            >
                                <PopupContent />
                            </box>
                        </box>
                    </revealer>
                </window>
            ) as Gtk.Window,
        )
    })
}
