import { Gtk } from "ags/gtk4"
import { createComputed } from "gnim"
import Config from "../../config"
import { formatMinutes, formatRemaining } from "../../lib/dndSnooze"
import {
    cancelDndSnooze,
    dndSnoozeEndsAt,
    setShareSnooze,
    shareSnooze,
    snoozeDnd,
} from "../../lib/notifd"
import { nowSec } from "../../lib/relTime"

/**
 * The DND button's right-click menu: snooze notifications for a while
 * (presets from [notifications] snooze_presets), or hold it for as long
 * as a screen share is running.
 *
 * The popover is deliberately NOT parented by JSX: gnim would append it
 * as a layout child of whatever box holds it, and a presented popover
 * must not take a slot in the card's column. The caller parents it to
 * the window instead (set_parent is a coordinate anchor, not a layout
 * registration — the same thing GtkTextView does with its emoji
 * chooser), points it at the DND button's bounds and pops it up; see
 * the right-click gesture in index.tsx.
 *
 * No <button> is nested inside another: the popover lives on its own
 * surface, so its item buttons are safe from the outer-clicks-win trap.
 */
export default function DndMenu(): Gtk.Popover {
    return (
        <popover hasArrow={false} cssClasses={["dndMenu"]}>
            <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                <label cssClasses={["dndMenuTitle"]} label="Snooze notifications" xalign={0} />
                {Config.notifications.snoozePresets.map(mins => (
                    <button
                        cssClasses={["dndMenuItem"]}
                        tooltipText={`Silence notifications for ${formatMinutes(mins)}`}
                        onClicked={self => {
                            snoozeDnd(mins)
                            popDndMenu(self)
                        }}
                    >
                        <label label={formatMinutes(mins)} halign={Gtk.Align.START} />
                    </button>
                ))}
                <Gtk.Separator orientation={Gtk.Orientation.HORIZONTAL} />
                <button
                    cssClasses={["dndMenuItem"]}
                    tooltipText="While a screen share or camera is running, keep notifications silenced"
                    onClicked={() => setShareSnooze(!shareSnooze.peek())}
                >
                    <box spacing={6}>
                        <label label="While screen sharing" hexpand xalign={0} />
                        {/* a fixed slot so checked and unchecked align */}
                        <box cssClasses={["dndMenuCheck"]}>
                            <image iconName="object-select-symbolic" visible={shareSnooze} />
                        </box>
                    </box>
                </button>
                <button
                    cssClasses={["dndMenuItem", "dndMenuCancel"]}
                    visible={dndSnoozeEndsAt.as(e => e !== null)}
                    onClicked={self => {
                        cancelDndSnooze()
                        popDndMenu(self)
                    }}
                >
                    <label
                        // ticks with the center's clock (held while the
                        // window is open — the only place this menu lives)
                        label={createComputed(() => {
                            const ends = dndSnoozeEndsAt()
                            if (ends === null) return "Cancel snooze"
                            return `Cancel — ${formatRemaining(ends - nowSec() * 1000)} left`
                        })}
                        halign={Gtk.Align.START}
                    />
                </button>
            </box>
        </popover>
    )
}

/** Close the menu from one of its own item buttons: the popover is the
 *  button's popup parent chain, not its root — walk up to it. */
function popDndMenu(w: Gtk.Widget) {
    let at: Gtk.Widget | null = w
    while (at && !(at instanceof Gtk.Popover)) at = at.get_parent()
    at?.popdown()
}
