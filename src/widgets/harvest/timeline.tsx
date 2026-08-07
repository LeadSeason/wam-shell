import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import Pango from "gi://Pango?version=1.0"
import { Accessor, For, With, createComputed, createState, onCleanup } from "gnim"
import { connect } from "../../lib/metrics"
import * as Harvest from "../../lib/harvest"
import { entryLabel, parseDuration, SelectorButton } from "./shared"
import { PaneEmpty } from "../PaneEmpty"

// the day timeline: per-row inline editors (notes, hours, project/task
// reassignment, delete) and the day browser header

// reassignment editor: move the entry to another project and/or task.
// The client follows implicitly (it is a property of the project in
// Harvest), so project rows are labeled "Client — Project". Selection
// is purely local — the row's Save commits it via updateEntry together
// with any notes edit
function AssignmentEditor({
    entry,
    projectSel,
    taskSel,
    onSelect,
}: {
    entry: Harvest.Entry
    projectSel: Accessor<number>
    taskSel: Accessor<number>
    onSelect: (projectId: number, taskId: number) => void
}) {
    let search: Gtk.Entry
    const [projectOpen, setProjectOpen] = createState(false)
    const [taskOpen, setTaskOpen] = createState(false)
    const [query, setQuery] = createState("")

    const labelOf = (p: Harvest.Project) => `${p.clientName} — ${p.projectName}`

    const projectRows = createComputed([Harvest.projects, query], (ps, q) =>
        ps.filter(p => !q || labelOf(p).toLowerCase().includes(q.toLowerCase())),
    )
    const tasks = createComputed(
        [Harvest.projects, projectSel],
        (ps, id) => ps.find(p => p.projectId === id)?.tasks ?? [],
    )

    // the entry's project may be archived (absent from the assignments
    // list): fall back to the names the entry itself carries
    const projectLabel = createComputed([Harvest.projects, projectSel], (ps, id) => {
        const p = ps.find(p => p.projectId === id)
        return p ? labelOf(p) : `${entry.clientName} — ${entry.projectName}`
    })
    const taskLabel = createComputed(
        [tasks, taskSel],
        (ts, id) => ts.find(t => t.taskId === id)?.taskName ?? entry.taskName,
    )

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

    return (
        <box orientation={Gtk.Orientation.VERTICAL} spacing={6} hexpand>
            <box orientation={Gtk.Orientation.VERTICAL}>
                <SelectorButton label={projectLabel} open={projectOpen} onClick={toggleProject} />
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
                                                // keep the task across the
                                                // move when the new project
                                                // has one with the same name
                                                const curName =
                                                    tasks
                                                        .get()
                                                        .find(t => t.taskId === taskSel.get())
                                                        ?.taskName ?? entry.taskName
                                                const t =
                                                    p.tasks.find(t => t.taskName === curName) ??
                                                    p.tasks[0]
                                                onSelect(p.projectId, t?.taskId ?? 0)
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
                    label={taskLabel}
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
                                        onSelect(projectSel.get(), t.taskId)
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
        </box>
    )
}

// one timeline row: start time, client — project · task (task is the
// visual primary), hours, notes on a dim second line when set. Clicking
// the row body expands an inline editor (notes + project/task
// reassignment; editing never starts a timer); resuming is explicit via
// the play button. The running entry is highlighted and inert (its
// notes live in the card above).
function TimelineRow({
    entry,
    startToday = false,
    onStarted,
}: {
    entry: Harvest.Entry
    // past-day row: the play button starts the same project+task as a
    // NEW entry today instead of restarting the old one on its old date
    startToday?: boolean
    // fired after a start-today, so the browser can jump back to today
    onStarted?: () => void
}) {
    const esc = (s: string) => GLib.markup_escape_text(s, -1)
    const time = Harvest.startTimeLabel(entry)
    const isPaused = Harvest.paused.as(p => p?.id === entry.id)

    const [expanded, setExpanded] = createState(false)
    // separate dirty tracking: notes text, hours and project/task
    // selection. One Save commits notes + assignment in a single PATCH
    // (updateEntry), hours via setHours (both modes)
    const [notesDirty, setNotesDirty] = createState(false)
    const [hoursDirty, setHoursDirty] = createState(false)
    const [projectSel, setProjectSel] = createState(entry.projectId)
    const [taskSel, setTaskSel] = createState(entry.taskId)
    const assignDirty = createComputed(
        [projectSel, taskSel],
        (p, t) => p !== entry.projectId || t !== entry.taskId,
    )
    const dirty = createComputed([notesDirty, hoursDirty, assignDirty], (n, h, a) => n || h || a)
    // two-step delete: trash swaps into confirm/cancel in place
    const [confirming, setConfirming] = createState(false)
    // row action buttons (resume/delete) hide until the row is hovered —
    // the freed width goes to the entry title. Driven by a motion
    // controller, not CSS :hover (unreliable on layer-shell surfaces)
    const [hovered, setHovered] = createState(false)
    // build the assignment editor on first expand, then keep it: eager
    // building would multiply the project list by every row of the day,
    // and a With keyed on `expanded` itself would vanish mid-collapse
    const [editorBuilt, setEditorBuilt] = createState(false)
    let notesBuffer: Gtk.TextBuffer | null = null
    let hoursEntry: Gtk.Entry | null = null
    const serverHours = () => Harvest.formatElapsed(entry.hours * 3600)

    const save = () => {
        const hoursText = hoursEntry?.get_text()
        if (hoursText !== undefined && hoursText !== serverHours()) {
            const hours = parseDuration(hoursText)
            // 0/empty/garbage is not a valid duration: snap back to the
            // server value (same contract as the paused hours editor)
            if (hours === null || hours <= 0) {
                hoursEntry?.set_text(serverHours())
                setHoursDirty(false)
            }
            // keep dirty when the update couldn't be attempted (busy,
            // running) or was rejected
            else
                Harvest.setHours(entry, hours, ok => {
                    if (ok) setHoursDirty(false)
                })
        }
        const fields: { notes?: string; projectId?: number; taskId?: number } = {}
        const text = notesBuffer?.text
        if (text !== undefined && text !== entry.notes) fields.notes = text
        if (assignDirty.get()) {
            fields.projectId = projectSel.get()
            fields.taskId = taskSel.get()
        }
        if (Object.keys(fields).length === 0) return
        // keep dirty when the update couldn't be attempted (busy) or was
        // rejected. On a successful PATCH the bumped updatedAt rebuilds
        // this row with fresh state, collapsing the editor — the new
        // values show in the row itself
        Harvest.updateEntry(entry, fields, ok => {
            if (ok) setNotesDirty(false)
        })
    }

    const cssClasses = isPaused.as(p => [
        "todayRow",
        ...(entry.isRunning ? ["running"] : []),
        ...(p ? ["paused"] : []),
    ])

    return (
        <box orientation={Gtk.Orientation.VERTICAL} cssClasses={cssClasses}>
            <Gtk.EventControllerMotion
                onEnter={() => setHovered(true)}
                onLeave={() => setHovered(false)}
            />
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
                        entry.isRunning ? entryLabel(entry) : `${entryLabel(entry)}\nclick to edit`
                    }
                    onClicked={() => {
                        if (!expanded.get()) setEditorBuilt(true)
                        setExpanded(!expanded.get())
                    }}
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
                    visible={createComputed(
                        [hovered, confirming],
                        (h, c) => !entry.isRunning && h && !c,
                    )}
                    sensitive={Harvest.busy.as(b => !b)}
                    tooltipText={startToday ? "Start today" : "Resume"}
                    onClicked={() => {
                        if (startToday) {
                            Harvest.startTimer(
                                entry.projectId,
                                entry.taskId,
                                entry.notes || undefined,
                            )
                            onStarted?.()
                        } else {
                            Harvest.resumeEntry(entry)
                        }
                    }}
                >
                    <image iconName="media-playback-start-symbolic" />
                </button>
                <button
                    cssClasses={["rowDelete"]}
                    valign={Gtk.Align.START}
                    visible={createComputed(
                        [hovered, confirming],
                        (h, c) => !entry.isRunning && h && !c,
                    )}
                    tooltipText={"Delete entry"}
                    onClicked={() => setConfirming(true)}
                >
                    <image iconName="user-trash-symbolic" />
                </button>
                {/* same footprint as the resume+delete pair it replaces:
                identical button padding and 6px spacing, no layout shift */}
                <box spacing={6} visible={confirming}>
                    <button
                        cssClasses={["confirm"]}
                        valign={Gtk.Align.START}
                        sensitive={Harvest.busy.as(b => !b)}
                        tooltipText={"Confirm delete"}
                        onClicked={() => {
                            Harvest.deleteEntry(entry)
                            setConfirming(false)
                        }}
                    >
                        <image iconName="object-select-symbolic" />
                    </button>
                    <button
                        cssClasses={["cancel"]}
                        valign={Gtk.Align.START}
                        tooltipText={"Cancel"}
                        onClicked={() => setConfirming(false)}
                    >
                        <image iconName="window-close-symbolic" />
                    </button>
                </box>
            </box>
            <revealer revealChild={expanded}>
                <box orientation={Gtk.Orientation.VERTICAL} spacing={6}>
                    {/* latched on first expand: not built for rows the
                    user never opens, and survives the collapse animation */}
                    <With value={editorBuilt}>
                        {/* null, not <></>: With appends the child into its
                        own Fragment, and nested Fragments are unsupported */}
                        {built =>
                            built ? (
                                <AssignmentEditor
                                    entry={entry}
                                    projectSel={projectSel}
                                    taskSel={taskSel}
                                    onSelect={(p, t) => {
                                        setProjectSel(p)
                                        setTaskSel(t)
                                    }}
                                />
                            ) : null
                        }
                    </With>
                    {/* accrued-time editor, same dirty contract as the
                    notes field (no focus-out commit). Insensitive while
                    running: setHours only applies to stopped entries */}
                    <box spacing={6} valign={Gtk.Align.CENTER}>
                        <label cssClasses={["dim"]} label={"Hours:"} />
                        <Gtk.Entry
                            $={self => {
                                hoursEntry = self
                                self.set_text(serverHours())
                            }}
                            cssClasses={["pausedEdit"]}
                            hexpand
                            tooltipText={"Edit hours (e.g. 1.5 or 1:30)"}
                            sensitive={!entry.isRunning}
                            onChanged={() =>
                                setHoursDirty(hoursEntry?.get_text() !== serverHours())
                            }
                            onActivate={save}
                        />
                    </box>
                    <box spacing={6} valign={Gtk.Align.START}>
                        {/* multi-line like the header's notes field: three
                        rows tall, grows to six, then scrolls. No Enter
                        commit — Enter inserts a newline; Save is explicit */}
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
                                    notesBuffer.set_text(entry.notes, -1)
                                    connect(notesBuffer, "changed", () =>
                                        setNotesDirty(notesBuffer?.text !== entry.notes),
                                    )
                                }}
                                wrapMode={Gtk.WrapMode.WORD_CHAR}
                            />
                        </Gtk.ScrolledWindow>
                        <button
                            cssClasses={["confirm"]}
                            valign={Gtk.Align.START}
                            visible={dirty}
                            sensitive={Harvest.busy.as(b => !b)}
                            onClicked={save}
                        >
                            <label label={"Save"} />
                        </button>
                    </box>
                </box>
            </revealer>
        </box>
    )
}

// the entire day as a timeline, ascending by start time (lib sorts).
// The header browses days: past days come from dayEntries (fetched per
// selection), today from the live todayEntries
export function Timeline() {
    // 0 = today, -1 = yesterday, …
    const [dayIdx, setDayIdx] = createState(0)
    // gnim subscribe callbacks receive no value — read the state
    const unsub = dayIdx.subscribe(() => {
        const i = dayIdx.get()
        if (i !== 0) Harvest.fetchDayOffset(i)
    })
    onCleanup(unsub)

    const entries = createComputed(
        [Harvest.todayEntries, Harvest.dayEntries, dayIdx],
        (today, past, i) => (i === 0 ? today : past),
    )

    const dayLabel = (i: number): string => {
        if (i === 0) return "Today"
        if (i === -1) return "Yesterday"
        const d = GLib.DateTime.new_now_local().add_days(i)!
        return d.format("%a, %d.%m.%Y") ?? ""
    }

    return (
        <box orientation={Gtk.Orientation.VERTICAL} spacing={6}>
            <box cssClasses={["section"]} spacing={4}>
                <button
                    cssClasses={["dayNav"]}
                    tooltipText={"Previous day"}
                    onClicked={() => setDayIdx(dayIdx.get() - 1)}
                >
                    <image iconName="go-previous-symbolic" />
                </button>
                <label label={dayIdx.as(dayLabel)} xalign={0.5} hexpand />
                <button
                    cssClasses={["dayNav"]}
                    tooltipText={"Next day"}
                    // never past today
                    sensitive={dayIdx.as(i => i < 0)}
                    onClicked={() => setDayIdx(Math.min(0, dayIdx.get() + 1))}
                >
                    <image iconName="go-next-symbolic" />
                </button>
            </box>
            {/* the same empty state the notification centre and the
            quick settings panes use, rather than a bare label against
            the left edge of an otherwise blank card */}
            <box visible={entries.as(e => e.length === 0)}>
                <PaneEmpty
                    icon="harvest-symbolic"
                    title="No entries"
                    hint="Start a timer, or add one with + New entry"
                />
            </box>
            <Gtk.ScrolledWindow
                vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
                hscrollbarPolicy={Gtk.PolicyType.NEVER}
                propagateNaturalHeight
                maxContentHeight={300}
                visible={entries.as(e => e.length > 0)}
            >
                <box orientation={Gtk.Orientation.VERTICAL} spacing={6}>
                    <For each={entries}>
                        {(e: Harvest.Entry) => (
                            <TimelineRow
                                entry={e}
                                startToday={dayIdx.get() !== 0}
                                onStarted={() => setDayIdx(0)}
                            />
                        )}
                    </For>
                </box>
            </Gtk.ScrolledWindow>
        </box>
    )
}
