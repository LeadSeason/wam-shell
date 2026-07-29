import { Gtk } from "ags/gtk4"
import { createPoll } from "ags/time"
import GLib from "gi://GLib?version=2.0"

// @TODO, Show upcoming events somehow? to work with Microsoft?, caldav? 

export default function Clock() {
    // @TODO, Better to have single instance?, instead per display.
    // one poll for both: the date used to tick a second timer every
    // second (per monitor) for a value that changes once a day
    const now = createPoll(["", ""] as [string, string], 1000, () => {
        const dt = GLib.DateTime.new_now_local()
        return [dt.format("%H:%M:%S")!, dt.format("%d.%m.%Y")!] as [string, string]
    })
    const time = now.as(([t]) => t)
    const date = now.as(([, d]) => d)

    return (
        <menubutton cssName={"clock"}>
            {/* centerbox hack to center the clock in the middle of the bar */}
            <centerbox>
                <box $type="start"
                    hexpand={true}
                    halign={Gtk.Align.END}
                >
                    <label cssName="clock-time" label={time} />
                </box>
                <box $type="center">
                    <label cssClasses={["separator"]} label={":"} />
                </box>
                <box $type="end">
                    <label cssName="clock-date" label={date} />
                </box>
            </centerbox>
            <popover
                hasArrow={false}
            >
                {/* https://docs.gtk.org/gtk4/class.Calendar.html */}
                <Gtk.Calendar
                    showWeekNumbers={true}
                />
            </popover>
        </menubutton>
    )
}