import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango?version=1.0"
import { Accessor } from "gnim"
import * as Harvest from "../../lib/harvest"

// shared bits of the harvest popup: entry labeling, duration parsing
// and the inline-selector button used by both selector editors

export const entryLabel = (e: Harvest.Entry) => `${e.clientName} — ${e.projectName} · ${e.taskName}`

// "1.5" decimal hours or "1:30" h:mm; empty parses to 0 (each caller
// decides what 0 means: live timer on the new-entry form, invalid on
// the paused-hours editor)
export function parseDuration(text: string): number | null {
    const t = text.trim()
    if (t === "") return 0
    const colon = t.match(/^(\d+):([0-5]?\d)$/)
    if (colon) return Number(colon[1]) + Number(colon[2]) / 60
    const h = Number(t)
    return Number.isFinite(h) && h >= 0 ? h : null
}

// shared by the new-entry form and the timeline row's reassignment
// editor: a button showing the current selection with an open/closed
// chevron, toggling an inline list (Gtk.DropDown popovers are unstyled
// here and their natural width follows the selected text, resizing the
// whole popup)
export function SelectorButton({
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
