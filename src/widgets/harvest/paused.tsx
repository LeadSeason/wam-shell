import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango?version=1.0"
import { With, createState, onCleanup } from "gnim"
import * as Harvest from "../../lib/harvest"
import { entryLabel, parseDuration } from "./shared"

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
        // keep dirty when the update couldn't be attempted (busy) or
        // the server rejected it
        Harvest.setHours(p, hours, ok => {
            if (ok) setDirty(false)
        })
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

// paused entry gets its own card: which entry it is, the hours editor
// and a resume button
export function PausedCard() {
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
