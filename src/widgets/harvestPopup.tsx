import { Astal, Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import Pango from "gi://Pango?version=1.0"
import Graphene from "gi://Graphene?version=1.0"
import app from "ags/gtk4/app"
import { Accessor, For, With, createComputed, createRoot, createState, onCleanup } from "gnim"
import CommandRegistry from "../lib/requestHandler"
import { timeoutAdd, sourceRemove, connect } from "../lib/metrics"
import { hideOnFocusLoss } from "../lib/popupFocus"
import * as Harvest from "../lib/harvest"
import Config from "../config"

// Harvest picker popup: drops below the panel pill (mediaPopup pattern).
// Left-click the pill to toggle, right-click for quick stop/resume.
// User-invoked, so entry details are never masked here.

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

const entryLabel = (e: Harvest.Entry) => `${e.clientName} — ${e.projectName} · ${e.taskName}`

// "1.5" decimal hours or "1:30" h:mm; empty parses to 0 (each caller
// decides what 0 means: live timer on the new-entry form, invalid on
// the paused-hours editor)
function parseDuration(text: string): number | null {
    const t = text.trim()
    if (t === "") return 0
    const colon = t.match(/^(\d+):([0-5]?\d)$/)
    if (colon) return Number(colon[1]) + Number(colon[2]) / 60
    const h = Number(t)
    return Number.isFinite(h) && h >= 0 ? h : null
}

// notes for the running entry; last-write-wins against web UI edits.
// poll results never clobber the field while it is focused or dirty,
// but a different timer taking over always resets it (the header is
// visibility-toggled now, not rebuilt per entry)
function NotesRow() {
    let buffer: Gtk.TextBuffer | null = null
    // Save stays hidden until the text actually differs from the server
    const [dirty, setDirty] = createState(false)
    let focused = false
    let lastId: number | null = Harvest.running.get()?.id ?? null

    const serverNotes = () => Harvest.running.get()?.notes ?? ""
    const currentText = () => buffer?.text ?? ""
    const save = () => {
        if (!buffer) return
        // keep dirty when the update couldn't be attempted (busy), so the
        // text isn't silently dropped
        if (Harvest.setNotes(currentText())) setDirty(false)
    }

    const unsub = Harvest.running.subscribe(() => {
        if (!buffer) return
        const id = Harvest.running.get()?.id ?? null
        if (id !== lastId) {
            // a different timer now: drop edits belonging to the old one
            lastId = id
            setDirty(false)
            buffer.set_text(serverNotes(), -1)
            return
        }
        if (dirty.get() || focused) return
        buffer.set_text(serverNotes(), -1)
    })
    onCleanup(unsub)

    return (
        <box spacing={6} sensitive={Harvest.busy.as(b => !b)}>
            {/* multi-line: a single-line entry forces horizontal
            scrolling for longer notes */}
            <Gtk.ScrolledWindow
                cssClasses={["input"]}
                hexpand
                propagateNaturalHeight
                minContentHeight={66}
                maxContentHeight={132}
                vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
                hscrollbarPolicy={Gtk.PolicyType.NEVER}
            >
                <Gtk.TextView
                    $={self => {
                        buffer = self.buffer
                        buffer.set_text(serverNotes(), -1)
                        connect(buffer, "changed", () => setDirty(currentText() !== serverNotes()))
                    }}
                    wrapMode={Gtk.WrapMode.WORD_CHAR}
                >
                    <Gtk.EventControllerFocus
                        onEnter={() => {
                            focused = true
                        }}
                        onLeave={() => {
                            // no auto-save: the layer-shell popup drops
                            // keyboard focus spontaneously ~1s after the
                            // last keystroke, which committed edits
                            // without the user asking. Save is explicit.
                            focused = false
                        }}
                    />
                </Gtk.TextView>
            </Gtk.ScrolledWindow>
            <button
                cssClasses={["confirm"]}
                valign={Gtk.Align.START}
                visible={dirty}
                onClicked={save}
            >
                <label label={"Save"} />
            </button>
        </box>
    )
}

function RunningHeader() {
    return (
        <box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
            <box spacing={8}>
                <image cssClasses={["harvestIcon"]} iconName="harvest-symbolic" pixelSize={20} />
                <label
                    cssClasses={["elapsed"]}
                    hexpand
                    xalign={0}
                    label={Harvest.elapsed.as(Harvest.formatElapsed)}
                />
                {/* the API has no pause: pause = stop + kept as the prominent
                resume target, resume = restart (same row keeps accruing) */}
                <button
                    cssClasses={["pause"]}
                    sensitive={Harvest.busy.as(b => !b)}
                    tooltipText={"Pause (resume later)"}
                    onClicked={() => Harvest.pauseTimer()}
                >
                    <image iconName="media-playback-pause-symbolic" />
                </button>
                <button
                    cssClasses={["stop"]}
                    sensitive={Harvest.busy.as(b => !b)}
                    tooltipText={"Stop"}
                    onClicked={() => Harvest.stopRunning()}
                >
                    <image iconName="media-playback-stop-symbolic" />
                </button>
            </box>
            <label
                xalign={0}
                maxWidthChars={38}
                ellipsize={Pango.EllipsizeMode.END}
                tooltipText={Harvest.running.as(r => (r ? entryLabel(r) : ""))}
                label={Harvest.running.as(r => (r ? entryLabel(r) : ""))}
            />
            <NotesRow />
        </box>
    )
}

// the Harvest-style new-entry form. Inline expanding selectors rather
// than Gtk.DropDown: dropdown popovers are unstyled here and their
// natural width follows the selected text, resizing the whole popup.
// Lives inside IdleContent's expander; Cancel collapses back to it
function NewEntryForm({ onCancel }: { onCancel: () => void }) {
    let notesBuffer: Gtk.TextBuffer
    let duration: Gtk.Entry
    let search: Gtk.Entry

    // selection by id, not index: the assignments array is replaced
    // wholesale on refresh, and an index would silently point at a
    // different project
    const [projectSel, setProjectSel] = createState(0)
    const [taskSel, setTaskSel] = createState(0)
    const [projectOpen, setProjectOpen] = createState(false)
    const [taskOpen, setTaskOpen] = createState(false)
    const [query, setQuery] = createState("")
    // the action button says what it will do: a duration logs (saves) a
    // completed entry, empty/zero starts a live timer
    const [actionLabel, setActionLabel] = createState("Start")
    // garbage must not silently no-op (#17): disable Start and mark the
    // field instead
    const [durationText, setDurationText] = createState("")
    const durationOk = durationText.as(t => t.trim() === "" || parseDuration(t) !== null)

    const labelOf = (p: Harvest.Project) => `${p.clientName} — ${p.projectName}`

    const projectRows = createComputed([Harvest.projects, query], (ps, q) =>
        ps.filter(p => !q || labelOf(p).toLowerCase().includes(q.toLowerCase())),
    )

    const tasks = createComputed(
        [Harvest.projects, projectSel],
        (ps, id) => ps.find(p => p.projectId === id)?.tasks ?? [],
    )

    // keep the selection pointing at something real after refreshes
    function reconcileSelection() {
        const ps = Harvest.projects.get()
        const p = ps.find(p => p.projectId === projectSel.get()) ?? ps[0]
        setProjectSel(p?.projectId ?? 0)
        if (!p?.tasks.some(t => t.taskId === taskSel.get())) {
            setTaskSel(p?.tasks[0]?.taskId ?? 0)
        }
    }
    reconcileSelection() // assignments usually land before the popup is built
    const unsubProjects = Harvest.projects.subscribe(reconcileSelection)
    onCleanup(unsubProjects)

    function start() {
        const p = Harvest.projects.get().find(p => p.projectId === projectSel.get())
        const t = p?.tasks.find(t => t.taskId === taskSel.get())
        if (!p || !t) return
        const hours = parseDuration(duration.get_text())
        if (hours === null) return
        const text = notesBuffer.text.trim() || undefined
        // 0 = start a live timer (replaces the running one); >0 = log a
        // completed entry and leave any running timer alone
        if (hours > 0) Harvest.addEntry(p.projectId, t.taskId, hours, text)
        else Harvest.startTimer(p.projectId, t.taskId, text)
        notesBuffer.set_text("", -1)
        duration.set_text("")
    }

    const canStart = createComputed(
        [Harvest.projects, Harvest.busy, durationOk],
        (ps, b, ok) => !b && ok && ps.length > 0,
    )

    // one open selector at a time; opening the project list focuses its
    // search entry so typing works immediately
    const toggleProject = () => {
        setTaskOpen(false)
        const opening = !projectOpen.get()
        setProjectOpen(opening)
        if (opening) search.grab_focus()
    }
    const toggleTask = () => {
        setProjectOpen(false)
        setTaskOpen(!taskOpen.get())
    }

    function SelectorButton({
        label,
        open,
        onClick,
        sensitive = true,
    }: {
        label: Accessor<string>
        open: Accessor<boolean>
        onClick: () => void
        sensitive?: boolean | Accessor<boolean>
    }) {
        return (
            <button cssClasses={["ddButton"]} sensitive={sensitive} onClicked={onClick}>
                <box>
                    <label
                        xalign={0}
                        hexpand
                        maxWidthChars={30}
                        ellipsize={Pango.EllipsizeMode.END}
                        label={label}
                    />
                    <image iconName={open.as(o => (o ? "pan-up-symbolic" : "pan-down-symbolic"))} />
                </box>
            </button>
        )
    }

    return (
        <box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
            <box orientation={Gtk.Orientation.VERTICAL}>
                <SelectorButton
                    label={createComputed([Harvest.projects, projectSel], (ps, id) => {
                        const p = ps.find(p => p.projectId === id)
                        return p ? labelOf(p) : "Select project"
                    })}
                    open={projectOpen}
                    onClick={toggleProject}
                />
                <revealer revealChild={projectOpen}>
                    <box cssClasses={["ddList"]} orientation={Gtk.Orientation.VERTICAL} spacing={4}>
                        <Gtk.Entry
                            $={self => {
                                search = self
                            }}
                            placeholderText={"Search…"}
                            onChanged={self => setQuery(self.get_text())}
                        />
                        <Gtk.ScrolledWindow
                            vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
                            hscrollbarPolicy={Gtk.PolicyType.NEVER}
                            propagateNaturalHeight
                            maxContentHeight={180}
                        >
                            <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                                <For each={projectRows}>
                                    {(p: Harvest.Project) => (
                                        <button
                                            tooltipText={labelOf(p)}
                                            onClicked={() => {
                                                setProjectSel(p.projectId)
                                                setTaskSel(p.tasks[0]?.taskId ?? 0)
                                                setProjectOpen(false)
                                                setQuery("")
                                                search.set_text("")
                                            }}
                                        >
                                            <label
                                                xalign={0}
                                                maxWidthChars={34}
                                                ellipsize={Pango.EllipsizeMode.END}
                                                label={labelOf(p)}
                                            />
                                        </button>
                                    )}
                                </For>
                            </box>
                        </Gtk.ScrolledWindow>
                    </box>
                </revealer>
            </box>

            <box orientation={Gtk.Orientation.VERTICAL}>
                <SelectorButton
                    label={createComputed(
                        [tasks, taskSel],
                        (ts, id) => ts.find(t => t.taskId === id)?.taskName ?? "Select task",
                    )}
                    open={taskOpen}
                    onClick={toggleTask}
                    sensitive={tasks.as(ts => ts.length > 0)}
                />
                <revealer revealChild={taskOpen}>
                    <box cssClasses={["ddList"]} orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                        <For each={tasks}>
                            {(t: { taskId: number; taskName: string }) => (
                                <button
                                    tooltipText={t.taskName}
                                    onClicked={() => {
                                        setTaskSel(t.taskId)
                                        setTaskOpen(false)
                                    }}
                                >
                                    <label
                                        xalign={0}
                                        maxWidthChars={34}
                                        ellipsize={Pango.EllipsizeMode.END}
                                        label={t.taskName}
                                    />
                                </button>
                            )}
                        </For>
                    </box>
                </revealer>
            </box>

            {/* notes taking the row (multi-line, grows downwards),
            duration adjacent on the right; both bounded (.input) */}
            <box spacing={6} valign={Gtk.Align.START}>
                <Gtk.ScrolledWindow
                    cssClasses={["input"]}
                    hexpand
                    propagateNaturalHeight
                    minContentHeight={66}
                    maxContentHeight={132}
                    vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
                    hscrollbarPolicy={Gtk.PolicyType.NEVER}
                >
                    <Gtk.TextView
                        $={self => {
                            notesBuffer = self.buffer
                        }}
                        wrapMode={Gtk.WrapMode.WORD_CHAR}
                    />
                </Gtk.ScrolledWindow>
                {/* right column: duration on top, action buttons below it,
                in the space the tall notes box frees up */}
                <box orientation={Gtk.Orientation.VERTICAL} spacing={6} valign={Gtk.Align.START}>
                    <Gtk.Entry
                        $={self => {
                            duration = self
                        }}
                        cssClasses={durationOk.as(ok => [
                            "input",
                            "duration",
                            ...(ok ? [] : ["invalid"]),
                        ])}
                        placeholderText={Harvest.formatElapsed(0)}
                        widthChars={5}
                        onChanged={self => {
                            const text = self.get_text()
                            setDurationText(text)
                            setActionLabel((parseDuration(text) ?? 0) > 0 ? "Save" : "Start")
                        }}
                        onActivate={start}
                    />
                    {/* natural width only: hexpand here would compete
                    with the notes box for the row's slack */}
                    <box homogeneous spacing={6}>
                        <button onClicked={onCancel}>
                            <label label={"Cancel"} />
                        </button>
                        <button cssClasses={["start"]} sensitive={canStart} onClicked={start}>
                            <label label={actionLabel} />
                        </button>
                    </box>
                </box>
            </box>
        </box>
    )
}

// editable accrued time of the paused entry. Same dirty/focus contract
// as NotesRow: a poll or in-place update never clobbers an edit in
// progress; Enter or Save commits. NO focus-out commit: the layer-shell
// popup drops keyboard focus spontaneously, and a silent hours PATCH is
// worse than a notes one (see bbb7575)
function PausedEditor() {
    let entry: Gtk.Entry | null = null
    const [dirty, setDirty] = createState(false)
    let focused = false

    const serverText = () => {
        const p = Harvest.paused.get()
        return p ? Harvest.formatElapsed(p.hours * 3600) : ""
    }
    const save = () => {
        const p = Harvest.paused.get()
        if (!entry || !p) return
        const hours = parseDuration(entry.get_text())
        // 0/empty/garbage is not a valid duration here (on the new-entry
        // form 0 means "live timer"): snap back to the server value
        if (hours === null || hours <= 0) {
            entry.set_text(serverText())
            setDirty(false)
            return
        }
        // keep dirty when the update couldn't be attempted (busy)
        if (Harvest.setHours(p, hours)) setDirty(false)
    }

    const unsub = Harvest.paused.subscribe(() => {
        if (dirty.get() || focused || !entry) return
        entry.set_text(serverText())
    })
    onCleanup(unsub)

    return (
        <box spacing={6} hexpand sensitive={Harvest.busy.as(b => !b)}>
            <label cssClasses={["elapsed", "dim"]} label={"Paused:"} />
            <Gtk.Entry
                $={self => {
                    entry = self
                    self.set_text(serverText())
                }}
                cssClasses={["pausedEdit"]}
                hexpand
                tooltipText={"Edit hours (e.g. 1.5 or 1:30)"}
                onChanged={() => {
                    setDirty(entry?.get_text() !== serverText())
                }}
                onActivate={save}
            >
                <Gtk.EventControllerFocus
                    onEnter={() => {
                        focused = true
                    }}
                    onLeave={() => {
                        focused = false
                    }}
                />
            </Gtk.Entry>
            <button cssClasses={["confirm"]} visible={dirty} onClicked={save}>
                <label label={"Save"} />
            </button>
        </box>
    )
}

// one timeline row: start time, client — project · task (task is the
// visual primary), hours, notes on a dim second line when set. Clicking
// the row body expands an inline notes editor (editing never starts a
// timer); resuming is explicit via the play button. The running entry
// is highlighted and inert (its notes live in the card above).
function TimelineRow({ entry }: { entry: Harvest.Entry }) {
    const esc = (s: string) => GLib.markup_escape_text(s, -1)
    const time = Harvest.startTimeLabel(entry)
    const isPaused = Harvest.paused.as(p => p?.id === entry.id)

    const [expanded, setExpanded] = createState(false)
    const [dirty, setDirty] = createState(false)
    let noteEntry: Gtk.Entry | null = null

    const save = () => {
        if (!noteEntry) return
        if (Harvest.setEntryNotes(entry, noteEntry.get_text())) setDirty(false)
    }

    const cssClasses = isPaused.as(p => [
        "todayRow",
        ...(entry.isRunning ? ["running"] : []),
        ...(p ? ["paused"] : []),
    ])

    return (
        <box orientation={Gtk.Orientation.VERTICAL} cssClasses={cssClasses}>
            <box spacing={6}>
                <label
                    cssClasses={["rowTime"]}
                    widthChars={5}
                    xalign={0}
                    visible={time !== ""}
                    label={time}
                />
                <button
                    cssClasses={["rowBody"]}
                    hexpand
                    sensitive={!entry.isRunning}
                    tooltipText={
                        entry.isRunning
                            ? entryLabel(entry)
                            : `${entryLabel(entry)}\nclick to edit notes`
                    }
                    onClicked={() => setExpanded(!expanded.get())}
                >
                    <box>
                        <box orientation={Gtk.Orientation.VERTICAL} hexpand>
                            <label
                                xalign={0}
                                useMarkup
                                maxWidthChars={32}
                                ellipsize={Pango.EllipsizeMode.END}
                                label={`<span alpha="60%">${esc(`${entry.clientName} — ${entry.projectName} · `)}</span><b>${esc(entry.taskName)}</b>`}
                            />
                            <label
                                cssClasses={["rowNotes"]}
                                xalign={0}
                                maxWidthChars={40}
                                ellipsize={Pango.EllipsizeMode.END}
                                visible={expanded.as(e => entry.notes !== "" && !e)}
                                label={entry.notes}
                            />
                        </box>
                        <label
                            cssClasses={["dim"]}
                            label={Harvest.formatElapsed(entry.hours * 3600)}
                        />
                    </box>
                </button>
                <button
                    cssClasses={["resumeNow"]}
                    valign={Gtk.Align.START}
                    visible={!entry.isRunning}
                    sensitive={Harvest.busy.as(b => !b)}
                    tooltipText={"Resume"}
                    onClicked={() => Harvest.resumeEntry(entry)}
                >
                    <image iconName="media-playback-start-symbolic" />
                </button>
            </box>
            <revealer revealChild={expanded}>
                <box spacing={6}>
                    <Gtk.Entry
                        $={self => {
                            noteEntry = self
                            self.set_text(entry.notes)
                        }}
                        cssClasses={["input"]}
                        hexpand
                        onChanged={() => setDirty(noteEntry?.get_text() !== entry.notes)}
                        onActivate={save}
                    />
                    <button cssClasses={["confirm"]} visible={dirty} onClicked={save}>
                        <label label={"Save"} />
                    </button>
                </box>
            </revealer>
        </box>
    )
}

// the entire day as a timeline, ascending by start time (lib sorts)
function Timeline() {
    return (
        <box
            orientation={Gtk.Orientation.VERTICAL}
            spacing={6}
            visible={Harvest.todayEntries.as(r => r.length > 0)}
        >
            <label cssClasses={["section"]} label={"Today"} xalign={0} />
            <Gtk.ScrolledWindow
                vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
                hscrollbarPolicy={Gtk.PolicyType.NEVER}
                propagateNaturalHeight
                maxContentHeight={300}
            >
                <box orientation={Gtk.Orientation.VERTICAL} spacing={6}>
                    <For each={Harvest.todayEntries}>
                        {(e: Harvest.Entry) => <TimelineRow entry={e} />}
                    </For>
                </box>
            </Gtk.ScrolledWindow>
        </box>
    )
}

// paused entry gets its own card: which entry it is, the hours editor
// and a resume button
function PausedCard() {
    const label = Harvest.paused.as(p => (p ? entryLabel(p) : ""))
    const tooltip = Harvest.paused.as(p =>
        p?.notes ? `${entryLabel(p)}\n${p.notes}` : p ? entryLabel(p) : "",
    )

    return (
        <box
            orientation={Gtk.Orientation.VERTICAL}
            spacing={4}
            visible={Harvest.paused.as(p => p !== null)}
        >
            <box spacing={8}>
                <image cssClasses={["harvestIcon"]} iconName="harvest-symbolic" pixelSize={20} />
                {/* keyed on the entry id: in-place updates (a successful
                hours edit) must not rebuild the editor under the user */}
                <With value={Harvest.paused.as(p => p?.id ?? null)}>
                    {/* null, not <></>: With appends the child into its own
                    Fragment, and nested Fragments are unsupported */}
                    {id => (id !== null ? <PausedEditor /> : null)}
                </With>
                <button
                    cssClasses={["resumeNow"]}
                    sensitive={Harvest.busy.as(b => !b)}
                    tooltipText={"Resume"}
                    onClicked={() => Harvest.resumeLast()}
                >
                    <image iconName="media-playback-start-symbolic" />
                </button>
            </box>
            {/* which entry is paused — meaningless hours without it */}
            <label
                cssClasses={["elapsed", "dim"]}
                xalign={0}
                maxWidthChars={44}
                ellipsize={Pango.EllipsizeMode.END}
                tooltipText={tooltip}
                label={label}
            />
        </box>
    )
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
    if (anchor) win!.gdkmonitor = anchor.monitor
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
