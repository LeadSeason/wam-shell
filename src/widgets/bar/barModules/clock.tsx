import { Gtk } from "ags/gtk4"
import { createPoll } from "ags/time"
import GLib from "gi://GLib?version=2.0"

// @TODO, Show upcoming events somehow? to work with Microsoft?, caldav?

// one shared poll for every bar (one per monitor previously): the date
// changes once a day and the time once a second, so a single 1s source
// serves all clocks. createPoll is lazy until subscribed, so this costs
// nothing when no clock is rendered.
const now = createPoll(["", ""] as [string, string], 1000, () => {
    const dt = GLib.DateTime.new_now_local()
    return [dt.format("%H:%M:%S")!, dt.format("%d.%m.%Y")!] as [string, string]
})

export default function Clock() {
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