import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango?version=1.0"
import { createState, onCleanup } from "gnim"
import { connect } from "../../lib/metrics"
import * as Harvest from "../../lib/harvest"
import { entryLabel } from "./shared"

// the running timer's card at the top of the popup: elapsed time,
// pause/stop controls and the live notes editor

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
        // keep dirty when the update couldn't be attempted (busy) or
        // the server rejected it — the text isn't silently dropped
        Harvest.setNotes(currentText(), ok => {
            if (ok) setDirty(false)
        })
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

export function RunningHeader() {
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
