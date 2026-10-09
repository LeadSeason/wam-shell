import { Gtk } from "ags/gtk4"
import { For, createComputed, createState } from "gnim"
import {
    coordsReady,
    timetable,
    pillLabel,
    rowsForDate,
    offsetNotes,
} from "../../../lib/prayerTimes"
import { WEEKDAYS } from "../../../lib/relTime"

// Prayer times pill: the next prayer's time (format per [prayer_times]
// pill_format), the popover browses any day's times. The wrapper box
// holds the bar slot while coordinates resolve asynchronously (GeoClue):
// a bare menubutton resolving late would be re-appended at the END of
// the bar (see AGENTS.md, late-binding rule). Hidden until coordsReady,
// so a disabled or unlocated module leaves no widget at all.

const dateFor = (offset: number) => {
    const d = new Date()
    d.setDate(d.getDate() + offset)
    return d
}

// "Today"/"Tomorrow"/"Yesterday", else "Fri, 2026-10-03" — weekday from
// relTime's English list, not the locale (see relTime.ts)
function dayLabel(offset: number): string {
    if (offset === 0) return "Today"
    if (offset === 1) return "Tomorrow"
    if (offset === -1) return "Yesterday"
    const d = dateFor(offset)
    const weekday = WEEKDAYS[(d.getDay() + 6) % 7].slice(0, 3) // Monday-first list
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${weekday}, ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function PrayerPopover() {
    // days from today the browser is showing; 0 = today (the ticking
    // timetable with its next-prayer highlight)
    const [offset, setOffset] = createState(0)

    const rows = createComputed(() => {
        const o = offset()
        return o === 0 ? timetable() : rowsForDate(dateFor(o))
    })
    const label = offset.as(dayLabel)

    return (
        <box cssClasses={["prayerTimesPopover"]} orientation={Gtk.Orientation.VERTICAL} spacing={4}>
            <box cssClasses={["prayerDayNav"]}>
                <button
                    cssClasses={["prayerDayBtn"]}
                    hexpand
                    onClicked={() => setOffset(offset.peek() - 1)}
                >
                    <image iconName="go-previous-symbolic" />
                </button>
                <button
                    cssClasses={["prayerDayLabel"]}
                    tooltipText="Back to today"
                    onClicked={() => setOffset(0)}
                >
                    <label halign={Gtk.Align.CENTER} label={label} />
                </button>
                <button
                    cssClasses={["prayerDayBtn"]}
                    hexpand
                    onClicked={() => setOffset(offset.peek() + 1)}
                >
                    <image iconName="go-next-symbolic" />
                </button>
            </box>
            {/* fixed slots, text bound per index: the set size is
                constant (3 or 5), so day browsing only swaps text — a
                For would destroy and recreate every row per click,
                which is the flash this replaces. Slots beyond the set
                size hide; GtkBox spacing skips invisible children */}
            {[0, 1, 2, 3, 4].map(i => (
                <box
                    cssClasses={rows.as(r => ["prayerRow", ...(r[i]?.next ? ["next"] : [])])}
                    visible={rows.as(r => i < r.length)}
                    spacing={8}
                >
                    <label xalign={0} hexpand label={rows.as(r => r[i]?.name ?? "")} />
                    <label cssClasses={["prayerTime"]} label={rows.as(r => r[i]?.label ?? "")} />
                </box>
            ))}
            {/* offsets section: only exists when any offset_* is set;
                the wrapper holds the popover's slot instead of an
                appearing/disappearing For row */}
            <box
                cssClasses={["prayerOffsets"]}
                orientation={Gtk.Orientation.VERTICAL}
                spacing={2}
                visible={offsetNotes.as(n => n.length > 0)}
            >
                <Gtk.Separator />
                <label cssClasses={["prayerOffsetsTitle"]} xalign={0} label={"Offsets"} />
                <For each={offsetNotes}>
                    {(note: string) => (
                        <label cssClasses={["prayerOffsetRow"]} xalign={0} label={note} />
                    )}
                </For>
            </box>
        </box>
    )
}

export default function PrayerTimes() {
    return (
        <box visible={coordsReady}>
            <menubutton cssClasses={["prayerTimes"]}>
                <label cssClasses={["prayerTimesPill"]} label={pillLabel} />
                <popover hasArrow={false}>
                    <PrayerPopover />
                </popover>
            </menubutton>
        </box>
    )
}
