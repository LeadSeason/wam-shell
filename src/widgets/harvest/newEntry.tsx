import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango?version=1.0"
import { For, createComputed, createState, onCleanup } from "gnim"
import * as Harvest from "../../lib/harvest"
import { parseDuration, SelectorButton } from "./shared"

// the Harvest-style new-entry form. Inline expanding selectors rather
// than Gtk.DropDown: dropdown popovers are unstyled here and their
// natural width follows the selected text, resizing the whole popup.
// Lives inside IdleContent's expander; Cancel collapses back to it
export function NewEntryForm({ onCancel }: { onCancel: () => void }) {
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
        // the actions no-op silently while a mutation is in flight or
        // auth is disabled: bailing here keeps the notes/duration the
        // user typed instead of clearing them for an entry that was
        // never created. The Start button is sensitive-gated on the
        // same state; the duration entry's onActivate is not
        if (Harvest.busy.get() || Harvest.authDisabled.get()) return
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
