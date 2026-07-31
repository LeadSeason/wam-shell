import { Gtk } from "ags/gtk4"
import { createPoll } from "ags/time"
import GLib from "gi://GLib?version=2.0"
import Pango from "gi://Pango?version=1.0"
import { For, createComputed, createState, onCleanup } from "gnim"
import * as Gcal from "../../../lib/gcal"
import { connect } from "../../../lib/metrics"

// one shared poll for every bar (one per monitor previously): the date
// changes once a day and the time once a second, so a single 1s source
// serves all clocks. createPoll is lazy until subscribed, so this costs
// nothing when no clock is rendered.
const now = createPoll(["", ""] as [string, string], 1000, () => {
    const dt = GLib.DateTime.new_now_local()
    return [dt.format("%H:%M:%S")!, dt.format("%d.%m.%Y")!] as [string, string]
})

// popover content: the plain Gtk.Calendar plus, when Google Calendar is
// configured, day marks for days with events and a list for the
// selected day. Marks are imperative (Gtk.Calendar API), re-applied on
// month navigation and on every sync
function CalendarPopover() {
    let cal: Gtk.Calendar | null = null
    const [selectedDay, setSelectedDay] = createState(Gcal.dayKey(Date.now()))

    const dayEvents = createComputed([Gcal.events, selectedDay], (evts, day) =>
        evts.filter(e => e.days.includes(day)),
    )

    const dayHeader = selectedDay.as(day => {
        const [y, m, d] = day.split("-").map(Number)
        return GLib.DateTime.new_local(y, m, d, 0, 0, 0).format("%a, %d.%m.%Y") ?? day
    })

    function remark() {
        if (!cal) return
        cal.clear_marks()
        if (!Gcal.active) return
        // marks apply to the displayed month; GLib months are 1-based
        const d = cal.get_date()
        const prefix = `${d.get_year()}-${String(d.get_month()).padStart(2, "0")}-`
        const marked = new Set<number>()
        for (const e of Gcal.events.get()) {
            for (const day of e.days) {
                if (!day.startsWith(prefix)) continue
                marked.add(Number(day.slice(8)))
            }
        }
        for (const day of marked) cal.mark_day(day)
    }

    // marks follow syncs even when the popover is closed
    const unsub = Gcal.events.subscribe(remark)
    onCleanup(unsub)

    return (
        <box orientation={Gtk.Orientation.VERTICAL} spacing={6}>
            {/* https://docs.gtk.org/gtk4/class.Calendar.html */}
            <Gtk.Calendar
                $={self => {
                    cal = self
                    remark()
                    // month navigation: re-mark (marks are per displayed
                    // month) and widen the sync window when it runs out
                    connect(self, "notify::date", () => {
                        remark()
                        const d = self.get_date()
                        Gcal.ensureCoverage(d.get_year(), d.get_month() - 1)
                    })
                }}
                showWeekNumbers={true}
                onDaySelected={self => {
                    setSelectedDay(self.get_date().format("%Y-%m-%d")!)
                }}
            />
            {Gcal.active ? (
                <box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
                    <label cssClasses={["gcalDay"]} xalign={0} label={dayHeader} />
                    <button
                        cssClasses={["gcalSignin"]}
                        visible={Gcal.authenticated.as(a => !a)}
                        onClicked={() => Gcal.authenticate()}
                    >
                        <label label={"Sign in to Google Calendar"} />
                    </button>
                    <Gtk.ScrolledWindow
                        visible={Gcal.authenticated}
                        vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
                        hscrollbarPolicy={Gtk.PolicyType.NEVER}
                        propagateNaturalHeight
                        maxContentHeight={160}
                    >
                        <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                            <For each={dayEvents}>
                                {(e: Gcal.CalEvent) => (
                                    <box cssClasses={["gcalEvent"]} spacing={6}>
                                        {/* calendar color is API data, not
                                        theme: the only inline style in the
                                        shell, by necessity */}
                                        <box
                                            cssClasses={["gcalDot"]}
                                            valign={Gtk.Align.CENTER}
                                            css={`
                                                background-color: ${e.color};
                                            `}
                                        />
                                        <label
                                            cssClasses={["gcalTime"]}
                                            label={Gcal.timeLabel(e)}
                                        />
                                        <label
                                            xalign={0}
                                            hexpand
                                            maxWidthChars={28}
                                            ellipsize={Pango.EllipsizeMode.END}
                                            tooltipText={`${e.summary} — ${e.calendarName}`}
                                            label={e.summary}
                                        />
                                    </box>
                                )}
                            </For>
                            <label
                                cssClasses={["gcalEmpty"]}
                                xalign={0}
                                visible={dayEvents.as(l => l.length === 0)}
                                label={"No events"}
                            />
                        </box>
                    </Gtk.ScrolledWindow>
                </box>
            ) : null}
        </box>
    )
}

export default function Clock() {
    const time = now.as(([t]) => t)
    const date = now.as(([, d]) => d)

    return (
        <menubutton
            cssName={"clock"}
            $={self => {
                // stale-while-revalidate each time the popover opens
                connect(self, "notify::active", () => {
                    if (self.active) Gcal.refresh()
                })
            }}
        >
            {/* centerbox hack to center the clock in the middle of the bar */}
            <centerbox>
                <box $type="start" hexpand={true} halign={Gtk.Align.END}>
                    <label cssName="clock-time" label={time} />
                </box>
                <box $type="center">
                    <label cssClasses={["separator"]} label={":"} />
                </box>
                <box $type="end">
                    <label cssName="clock-date" label={date} />
                </box>
            </centerbox>
            <popover hasArrow={false}>
                <CalendarPopover />
            </popover>
        </menubutton>
    )
}
