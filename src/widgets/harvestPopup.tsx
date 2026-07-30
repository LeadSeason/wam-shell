import { Astal, Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import Pango from "gi://Pango?version=1.0"
import Graphene from "gi://Graphene?version=1.0"
import app from "ags/gtk4/app"
import { Accessor, For, With, createComputed, createRoot, createState } from "gnim"
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
            tooltipText={Harvest.running.as(r => r ? entryLabel(r) : "")}
            label={Harvest.running.as(r => r ? entryLabel(r) : "")} />
        <NotesRow />
    </box>
}

// the Harvest-style new-entry form. Inline expanding selectors rather
// than Gtk.DropDown: dropdown popovers are unstyled here and their
// natural width follows the selected text, resizing the whole popup
function NewEntryForm() {
    let notes: Gtk.Entry
    let duration: Gtk.Entry
    let search: Gtk.Entry

    const [projectSel, setProjectSel] = createState(0)
    const [taskSel, setTaskSel] = createState(0)
    const [projectOpen, setProjectOpen] = createState(false)
    const [taskOpen, setTaskOpen] = createState(false)
    const [query, setQuery] = createState("")

    const labelOf = (p: Harvest.Project) => `${p.clientName} — ${p.projectName}`

    // rows carry their original index so filtering keeps the id mapping
    const projectRows = createComputed([Harvest.projects, query], (ps, q) =>
        ps.map((p, i) => ({ p, i }))
            .filter(({ p }) => !q || labelOf(p).toLowerCase().includes(q.toLowerCase())))

    const tasks = createComputed([Harvest.projects, projectSel],
        (ps, sel) => ps[sel]?.tasks ?? [])

    // "1.5" decimal hours or "1:30" h:mm; empty = 0 = start a live timer
    function parseDuration(text: string): number | null {
        const t = text.trim()
        if (t === "") return 0
        const colon = t.match(/^(\d+):([0-5]?\d)$/)
        if (colon) return Number(colon[1]) + Number(colon[2]) / 60
        const h = Number(t)
        return Number.isFinite(h) && h >= 0 ? h : null
    }

    function start() {
        const p = Harvest.projects.get()[projectSel.get()]
        const t = p?.tasks[taskSel.get()]
        if (!p || !t) return
        const hours = parseDuration(duration.get_text())
        if (hours === null) return
        const text = notes.get_text().trim() || undefined
        // 0 = start a live timer (replaces the running one); >0 = log a
        // completed entry and leave any running timer alone
        if (hours > 0) Harvest.addEntry(p.projectId, t.taskId, hours, text)
        else Harvest.startTimer(p.projectId, t.taskId, text)
        notes.set_text("")
        duration.set_text("")
    }

    const canStart = createComputed([Harvest.projects, Harvest.busy],
        (ps, b) => !b && ps.length > 0)

    // one open selector at a time; opening the project list focuses its
    // search entry so typing works immediately
    const toggleProject = () => {
        setTaskOpen(false)
        const opening = !projectOpen.get()
        setProjectOpen(opening)
        if (opening) search.grab_focus()
    }
    const toggleTask = () => { setProjectOpen(false); setTaskOpen(!taskOpen.get()) }

    function SelectorButton({ label, open, onClick, sensitive = true }: {
        label: Accessor<string>, open: Accessor<boolean>,
        onClick: () => void, sensitive?: boolean | Accessor<boolean>
    }) {
        return <button cssClasses={["ddButton"]} sensitive={sensitive} onClicked={onClick}>
            <box>
                <label xalign={0} hexpand maxWidthChars={30}
                    ellipsize={Pango.EllipsizeMode.END} label={label} />
                <image iconName={open.as(o => o ? "pan-up-symbolic" : "pan-down-symbolic")} />
            </box>
        </button>
    }

    return <box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
        <label cssClasses={["title"]} label={"New Time Entry"} halign={Gtk.Align.CENTER} />

        <box orientation={Gtk.Orientation.VERTICAL}>
            <SelectorButton
                label={createComputed([Harvest.projects, projectSel],
                    (ps, s) => ps[s] ? labelOf(ps[s]) : "Select project")}
                open={projectOpen}
                onClick={toggleProject}
            />
            <revealer revealChild={projectOpen}>
                <box cssClasses={["ddList"]} orientation={Gtk.Orientation.VERTICAL} spacing={4}>
                    <Gtk.Entry
                        $={(self) => { search = self }}
                        placeholderText={"Search…"}
                        onChanged={(self) => setQuery(self.get_text())}
                    />
                    <Gtk.ScrolledWindow
                        vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
                        hscrollbarPolicy={Gtk.PolicyType.NEVER}
                        propagateNaturalHeight
                        maxContentHeight={180}
                    >
                        <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                            <For each={projectRows}>{({ p, i }: { p: Harvest.Project, i: number }) =>
                                <button tooltipText={labelOf(p)} onClicked={() => {
                                    setProjectSel(i)
                                    setTaskSel(0)
                                    setProjectOpen(false)
                                    setQuery("")
                                    search.set_text("")
                                }}>
                                    <label xalign={0} maxWidthChars={34}
                                        ellipsize={Pango.EllipsizeMode.END} label={labelOf(p)} />
                                </button>
                            }</For>
                        </box>
                    </Gtk.ScrolledWindow>
                </box>
            </revealer>
        </box>

        <box orientation={Gtk.Orientation.VERTICAL}>
            <SelectorButton
                label={tasks.as(ts => ts[taskSel.get()]?.taskName ?? "Select task")}
                open={taskOpen}
                onClick={toggleTask}
                sensitive={tasks.as(ts => ts.length > 0)}
            />
            <revealer revealChild={taskOpen}>
                <box cssClasses={["ddList"]} orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                    <For each={tasks}>{(t: { taskId: number, taskName: string }, i: Accessor<number>) =>
                        <button tooltipText={t.taskName}
                            onClicked={() => { setTaskSel(i.get()); setTaskOpen(false) }}>
                            <label xalign={0} maxWidthChars={34}
                                ellipsize={Pango.EllipsizeMode.END} label={t.taskName} />
                        </button>
                    }</For>
                </box>
            </revealer>
        </box>

        <box spacing={6}>
            <Gtk.Entry
                $={(self) => { notes = self }}
                placeholderText={"Add Notes"}
                hexpand
                onActivate={start}
            />
            <Gtk.Entry
                $={(self) => { duration = self }}
                cssClasses={["duration"]}
                placeholderText={Harvest.formatElapsed(0)}
                widthChars={5}
                onActivate={start}
            />
        </box>
        <box halign={Gtk.Align.END} spacing={6}>
            <button onClicked={() => hide()}>
                <label label={"Cancel"} />
            </button>
            <button cssClasses={["start"]} sensitive={canStart} onClicked={start}>
                <label label={"Start"} />
            </button>
        </box>
    </box>
}

function IdleContent() {
    // up to three resume targets: paused first, then today's stopped
    // entries, padded from the wide recents window; deduped by id
    const resumables = createComputed(
        [Harvest.paused, Harvest.recentStopped, Harvest.recents],
        (p, stopped, rec) => {
            const out: Harvest.Entry[] = []
            const seen = new Set<number>()
            for (const e of [p, ...stopped, ...rec]) {
                if (!e || seen.has(e.id)) continue
                seen.add(e.id)
                out.push(e)
                if (out.length >= 3) break
            }
            return out
        })
    return <box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
        <box spacing={8}
            visible={createComputed([Harvest.paused, Harvest.dayTotal],
                (p, t) => p !== null || t > 0)}>
            <image cssClasses={["harvestIcon"]} iconName="harvest-symbolic" pixelSize={20} />
            <label cssClasses={["elapsed", "dim"]} hexpand xalign={0}
                label={createComputed([Harvest.paused, Harvest.dayTotal],
                    (p, t) => p
                        ? `Paused: ${Harvest.formatElapsed(p.hours * 3600)}`
                        : `Today: ${Harvest.formatElapsed(t)}`)} />
        </box>
        <NewEntryForm />
        <box orientation={Gtk.Orientation.VERTICAL} spacing={2}
            visible={resumables.as(r => r.length > 0)}>
            <label cssClasses={["section"]} label={"Resume"} xalign={0} />
            <For each={resumables}>{(e: Harvest.Entry) =>
                <button cssClasses={["resume"]} sensitive={Harvest.busy.as(b => !b)}
                    tooltipText={entryLabel(e)}
                    onClicked={() => Harvest.resumeEntry(e)}>
                    <label xalign={0} hexpand maxWidthChars={38}
                        ellipsize={Pango.EllipsizeMode.END}
                        label={entryLabel(e)} />
                </button>
            }</For>
        </box>
    </box>
}

function PopupContent() {
    // running = the timer on top of the same new-entry form, so a
    // completed entry can be logged without stopping the live one
    return <box cssClasses={["harvestPopup"]} orientation={Gtk.Orientation.VERTICAL}
        spacing={10} widthRequest={340}>
        <With value={Harvest.running}>
        {r => r &&
            <box orientation={Gtk.Orientation.VERTICAL} spacing={10}>
                <RunningHeader />
                <Gtk.Separator />
            </box>}
    </With>
        <IdleContent />
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
    // and sync anything that changed since the last tick right now
    Harvest.deltaPoll()
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
        app.add_window(<window
            $={(self) => { win = self }}
            name="HarvestPopup"
            class="HarvestPopup"
            namespace="harvest-popup"
            anchor={Astal.WindowAnchor.TOP | Astal.WindowAnchor.BOTTOM
                | Astal.WindowAnchor.LEFT | Astal.WindowAnchor.RIGHT}
            // ON_DEMAND, not EXCLUSIVE: dropdown lists and text entries
            // cannot grab the seat under EXCLUSIVE
            keymode={Astal.Keymode.ON_DEMAND}
            visible={false}
        >
            <Gtk.EventControllerKey onKeyPressed={onKey} />
            <Gtk.GestureClick onPressed={onClick} />
            <revealer
                $={(self) => { rev = self }}
                transitionDuration={200}
                transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
            >
                <box
                    valign={Gtk.Align.START}
                    halign={popupAnchor.as(a => a ? Gtk.Align.START : fallbackAlign())}
                    marginTop={30}
                    marginStart={popupAnchor.as(() => popupMarginLeft())}
                    marginEnd={12}
                >
                    <box $={(self) => { card = self }}>
                        <PopupContent />
                    </box>
                </box>
            </revealer>
        </window> as Gtk.Window)
    })
}
