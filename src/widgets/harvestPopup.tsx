import { Astal, Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import Pango from "gi://Pango?version=1.0"
import Graphene from "gi://Graphene?version=1.0"
import app from "ags/gtk4/app"
import { For, With, createComputed, createRoot, createState } from "gnim"
import CommandRegistry from "../lib/requestHandler"
import * as Harvest from "../lib/harvest"
import Config from "../config"

// Harvest picker popup: drops below the panel pill (mediaPopup pattern).
// Left-click the pill to toggle, right-click for quick stop/resume.
// User-invoked, so entry details are never masked here.

const registry = CommandRegistry.get_default()

/** where the pill was clicked: the popup drops directly below it */
export const [popupAnchor, setPopupAnchor] =
    createState<{ x: number, monitor: Gdk.Monitor } | null>(null)

// the popup appears where the pill is: centered for the center section,
// top-left/top-right for the side sections
function harvestAnchor(): number {
    const { TOP, LEFT, RIGHT } = Astal.WindowAnchor
    const zones = new Set<string>()
    for (const p of Config.panels) {
        if (p.left.includes("harvest")) zones.add("left")
        if (p.center.includes("harvest")) zones.add("center")
        if (p.right.includes("harvest")) zones.add("right")
    }
    if (zones.has("center")) return TOP
    if (zones.has("left") && !zones.has("right")) return TOP | LEFT
    if (zones.has("right") && !zones.has("left")) return TOP | RIGHT
    return zones.size === 0 ? TOP | RIGHT : TOP
}

const entryLabel = (e: Harvest.Entry) =>
    `${e.clientName} — ${e.projectName} · ${e.taskName}`

// notes for the running entry; last-write-wins against web UI edits.
// poll results never clobber the field while it is focused or dirty
function NotesRow() {
    let entry: Gtk.Entry | null = null
    let dirty = false
    let focused = false

    const serverNotes = () => Harvest.running.get()?.notes ?? ""
    const save = () => {
        if (!entry) return
        Harvest.setNotes(entry.get_text())
        dirty = false
    }

    Harvest.running.subscribe(() => {
        if (dirty || focused || !entry) return
        entry.set_text(serverNotes())
    })

    return <box spacing={6} sensitive={Harvest.busy.as(b => !b)}>
        <Gtk.Entry
            $={(self) => { entry = self; self.set_text(serverNotes()) }}
            placeholderText={"Notes…"}
            hexpand
            onChanged={() => { dirty = entry?.get_text() !== serverNotes() }}
            onActivate={save}
        >
            <Gtk.EventControllerFocus
                onEnter={() => { focused = true }}
                onLeave={() => { focused = false; if (dirty) save() }} />
        </Gtk.Entry>
        <button cssClasses={["confirm"]} onClicked={save}>
            <label label={"Save"} />
        </button>
    </box>
}

function RunningHeader() {
    return <box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
        <box spacing={8}>
            <image cssClasses={["harvestIcon"]} iconName="harvest-symbolic" pixelSize={20} />
            <label cssClasses={["elapsed"]} hexpand xalign={0}
                label={Harvest.elapsed.as(Harvest.formatElapsed)} />
            {/* the API has no pause: pause = stop + kept as the prominent
                resume target, resume = restart (same row keeps accruing) */}
            <button cssClasses={["pause"]} sensitive={Harvest.busy.as(b => !b)}
                tooltipText={"Pause (resume later)"}
                onClicked={() => Harvest.pauseTimer()}>
                <image iconName="media-playback-pause-symbolic" />
            </button>
            <button cssClasses={["stop"]} sensitive={Harvest.busy.as(b => !b)}
                tooltipText={"Stop"}
                onClicked={() => Harvest.stopRunning()}>
                <image iconName="media-playback-stop-symbolic" />
            </button>
        </box>
        <label xalign={0} maxWidthChars={38} ellipsize={Pango.EllipsizeMode.END}
            label={Harvest.running.as(r => r ? entryLabel(r) : "")} />
        <NotesRow />
    </box>
}

function IdleHeader() {
    const resumeTarget = createComputed(
        [Harvest.paused, Harvest.lastStopped, Harvest.recents],
        (p, ls, rec) => p ?? ls ?? rec[0] ?? null)
    return <box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
        <box spacing={8}>
            <image cssClasses={["harvestIcon"]} iconName="harvest-symbolic" pixelSize={20} />
            <label cssClasses={["elapsed", "dim"]} hexpand xalign={0}
                label={createComputed([Harvest.paused, Harvest.dayTotal],
                    (p, t) => p
                        ? `Paused: ${Harvest.formatElapsed(p.hours * 3600)}`
                        : t > 0 ? `Today: ${Harvest.formatElapsed(t)}`
                            : "No time logged today")} />
        </box>
        <button cssClasses={["resume"]} sensitive={Harvest.busy.as(b => !b)}
            visible={resumeTarget.as(t => t !== null)}
            onClicked={() => Harvest.resumeLast()}>
            <label xalign={0} hexpand maxWidthChars={38}
                ellipsize={Pango.EllipsizeMode.END}
                label={resumeTarget.as(t => t ? `Resume: ${entryLabel(t)}` : "")} />
        </button>
    </box>
}

function Picker() {
    const [expanded, setExpanded] = createState(0)
    return <Gtk.ScrolledWindow
        vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
        hscrollbarPolicy={Gtk.PolicyType.NEVER}
        propagateNaturalHeight
        maxContentHeight={360}
    >
        <box orientation={Gtk.Orientation.VERTICAL} spacing={2}
            sensitive={Harvest.busy.as(b => !b)}>
            <For each={Harvest.recents}>{(e: Harvest.Entry) =>
                <button onClicked={() => Harvest.startTimer(e.projectId, e.taskId)}>
                    <label xalign={0} maxWidthChars={38}
                        ellipsize={Pango.EllipsizeMode.END} label={entryLabel(e)} />
                </button>
            }</For>

            <Gtk.Separator visible={Harvest.projects.as(p => p.length > 0)} />

            <For each={Harvest.projects}>{(p: Harvest.Project) =>
                <box orientation={Gtk.Orientation.VERTICAL}>
                    {/* single-child rule: a Gtk.Button keeps only its last
                        child, so label + icon go in one box */}
                    <button onClicked={() =>
                        setExpanded(expanded.get() === p.projectId ? 0 : p.projectId)}>
                        <box>
                            <label xalign={0} hexpand maxWidthChars={34}
                                ellipsize={Pango.EllipsizeMode.END}
                                label={`${p.clientName} — ${p.projectName}`} />
                            <image iconName={expanded.as(id =>
                                id === p.projectId ? "pan-up-symbolic" : "pan-down-symbolic")} />
                        </box>
                    </button>
                    <revealer revealChild={expanded.as(id => id === p.projectId)}>
                        <box cssClasses={["taskList"]} orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                            {p.tasks.map(t =>
                                <button onClicked={() => Harvest.startTimer(p.projectId, t.taskId)}>
                                    <label xalign={0} label={t.taskName} />
                                </button>)}
                        </box>
                    </revealer>
                </box>
            }</For>
        </box>
    </Gtk.ScrolledWindow>
}

function PopupContent() {
    return <box cssClasses={["harvestPopup"]} orientation={Gtk.Orientation.VERTICAL}
        spacing={10} widthRequest={340}>
        <With value={Harvest.running}>
        {r => r ? <RunningHeader /> : <IdleHeader />}
    </With>
        <Gtk.Separator />
        <Picker />
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
    // stale-while-revalidate the near-static data on open
    Harvest.refreshSlow()
    const anchor = popupAnchor.get()
    if (anchor) win!.gdkmonitor = anchor.monitor
    win!.present()
    rev!.revealChild = true
}

// pill-centered, but never past the monitor's right edge
function popupMarginLeft(): number {
    const anchor = popupAnchor.get()
    if (!anchor) return 12
    // window width: 340 request + horizontal margins
    const POPUP_W = 340 + 24
    const monW = anchor.monitor.get_geometry().width
    return Math.max(0, Math.min(Math.round(anchor.x - POPUP_W / 2), monW - POPUP_W))
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
    }
})

function onKey(_e: Gtk.EventControllerKey, keyValue: number) {
    if (keyValue === Gdk.KEY_Escape) hide()
}

function onClick(_e: Gtk.GestureClick, _: number, x: number, y: number) {
    const [, rect] = win!.get_child()!.compute_bounds(win!)
    if (!rect.contains_point(new Graphene.Point({ x, y }))) hide()
}

function ensureWindow() {
    if (win) return
    createRoot(() => {
        app.add_window(<window
            $={(self) => { win = self }}
            name="HarvestPopup"
            class="HarvestPopup"
            namespace="harvest-popup"
            anchor={popupAnchor.as(a => a
                ? (Astal.WindowAnchor.TOP | Astal.WindowAnchor.LEFT)
                : harvestAnchor())}
            marginTop={30}
            marginRight={12}
            marginLeft={popupAnchor.as(() => popupMarginLeft())}
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
                <PopupContent />
            </revealer>
        </window> as Gtk.Window)
    })
}
