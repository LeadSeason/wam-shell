import { Gtk } from "ags/gtk4"
import { createPoll } from "ags/time"
import GLib from "gi://GLib?version=2.0"
import Pango from "gi://Pango?version=1.0"
import { For, createComputed, createState } from "gnim"
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

// weekday initials, Monday first, locale-aware (2024-01-01 was a Monday)
const WEEKDAYS = Array.from(
    { length: 7 },
    (_, i) => GLib.DateTime.new_local(2024, 1, 1 + i, 12, 0, 0).format("%a") ?? "",
)

interface GridCell extends Gcal.GridDay {
    today: boolean
    selected: boolean
    dots: string[] // up to 3 calendar colors with events that day
}

// Two-pane calendar popover (GNOME-shell style): custom month grid on
// the left — today/selected rings, per-calendar event dots — agenda of
// upcoming days on the right with per-calendar color bars. No stock
// Gtk.Calendar: it can't show dots, and its Adwaita chrome clashes with
// the theme. Without Google Calendar the month pane stands alone.
function CalendarPopover() {
    const now0 = new Date()
    const todayKey = Gcal.dayKey(now0.getTime())
    const [viewY, setViewY] = createState(now0.getFullYear())
    const [viewM, setViewM] = createState(now0.getMonth()) // 0-based
    // the agenda starts here; clicking a day in the grid moves it
    const [selectedDay, setSelectedDay] = createState(todayKey)

    const monthLabel = createComputed(
        [viewY, viewM],
        (y, m) => GLib.DateTime.new_local(y, m + 1, 1, 0, 0, 0).format("%B %Y") ?? "",
    )

    const grid = createComputed(
        [viewY, viewM, selectedDay, Gcal.visibleEvents],
        (y, m, sel, evts) => {
            // day -> up to 3 distinct calendar colors with events that day
            const dots = new Map<string, string[]>()
            for (const e of evts) {
                for (const d of e.days) {
                    let arr = dots.get(d)
                    if (!arr) dots.set(d, (arr = []))
                    if (arr.length < 3 && !arr.includes(e.color)) arr.push(e.color)
                }
            }
            return Gcal.monthGrid(y, m).map(week =>
                week.map((day): GridCell => ({
                    ...day,
                    today: day.key === todayKey,
                    selected: day.key === sel,
                    dots: dots.get(day.key) ?? [],
                })),
            )
        },
    )

    // agenda pane: days with events from the selected day onward,
    // empty days skipped (Google's schedule layout)
    const agenda = createComputed([Gcal.visibleEvents, selectedDay], (evts, day) =>
        Gcal.agendaGroups(evts, day, todayKey),
    )

    const nav = (delta: number) => {
        let m = viewM.get() + delta
        let y = viewY.get()
        if (m < 0) {
            m = 11
            y--
        } else if (m > 11) {
            m = 0
            y++
        }
        setViewY(y)
        setViewM(m)
        Gcal.ensureCoverage(y, m)
    }

    const goToday = () => {
        const n = new Date()
        setViewY(n.getFullYear())
        setViewM(n.getMonth())
        setSelectedDay(Gcal.dayKey(n.getTime()))
        Gcal.ensureCoverage(n.getFullYear(), n.getMonth())
    }

    const pick = (day: GridCell) => {
        setSelectedDay(day.key)
        // a dimmed adjacent-month day: jump the view to its month
        if (!day.inMonth) {
            const [y, m] = day.key.split("-").map(Number)
            setViewY(y)
            setViewM(m - 1)
            Gcal.ensureCoverage(y, m - 1)
        }
    }

    const cellClass = (day: GridCell) => [
        "calDay",
        ...(day.inMonth ? [] : ["otherMonth"]),
        ...(day.today ? ["today"] : []),
        ...(day.selected ? ["selected"] : []),
    ]

    const monthPane = (
        <box cssClasses={["monthPane"]} orientation={Gtk.Orientation.VERTICAL} spacing={6}>
            <box cssClasses={["monthHeader"]}>
                <button cssClasses={["monthNav"]} onClicked={() => nav(-1)}>
                    <image iconName="go-previous-symbolic" />
                </button>
                <button cssClasses={["monthLabel"]} hexpand onClicked={goToday}>
                    <label label={monthLabel} />
                </button>
                <button cssClasses={["monthNav"]} onClicked={() => nav(1)}>
                    <image iconName="go-next-symbolic" />
                </button>
            </box>
            <box homogeneous>
                {WEEKDAYS.map(w => (
                    <label cssClasses={["weekday"]} label={w} />
                ))}
            </box>
            <For each={grid}>
                {(week: GridCell[]) => (
                    <box homogeneous>
                        {/* plain map: cells are static within the week row
                        the outer For rebuilds */}
                        {week.map(day => (
                            <button cssClasses={cellClass(day)} onClicked={() => pick(day)}>
                                <box orientation={Gtk.Orientation.VERTICAL}>
                                    <label label={String(day.num)} />
                                    <box
                                        cssClasses={["calDots"]}
                                        halign={Gtk.Align.CENTER}
                                        spacing={2}
                                    >
                                        {day.dots.map(c => (
                                            <box
                                                cssClasses={["calDot"]}
                                                css={`
                                                    background-color: ${c};
                                                `}
                                            />
                                        ))}
                                    </box>
                                </box>
                            </button>
                        ))}
                    </box>
                )}
            </For>
        </box>
    )

    return (
        <box cssClasses={["clockPopover"]} spacing={16}>
            {Gcal.active ? (
                <box spacing={16}>
                    {/* picker pane: visibility toggles per calendar,
                    sign-in/add account at the bottom */}
                    <box
                        cssClasses={["calPane"]}
                        orientation={Gtk.Orientation.VERTICAL}
                        spacing={6}
                    >
                        <label cssClasses={["paneTitle"]} xalign={0} label={"Calendars"} />
                        <Gtk.ScrolledWindow
                            vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
                            hscrollbarPolicy={Gtk.PolicyType.NEVER}
                            propagateNaturalHeight
                            maxContentHeight={250}
                            vexpand
                        >
                            <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                                <For each={Gcal.calendars}>
                                    {(cal: Gcal.CalInfo) => (
                                        <button
                                            cssClasses={["calRow"]}
                                            tooltipText={`${cal.summary} — ${cal.account}`}
                                            onClicked={() => Gcal.toggleCalendar(cal.id)}
                                        >
                                            <box spacing={6}>
                                                <box
                                                    cssClasses={["calCheck"]}
                                                    valign={Gtk.Align.CENTER}
                                                    // calendar color is API
                                                    // data, not theme
                                                    css={Gcal.visibilityOverrides.as(ovs => {
                                                        const v = Gcal.calendarVisible(cal, ovs)
                                                        return `background-color: ${v ? cal.color : "transparent"}; border-color: ${cal.color};`
                                                    })}
                                                />
                                                <label
                                                    xalign={0}
                                                    hexpand
                                                    maxWidthChars={14}
                                                    ellipsize={Pango.EllipsizeMode.END}
                                                    label={cal.summary}
                                                />
                                            </box>
                                        </button>
                                    )}
                                </For>
                            </box>
                        </Gtk.ScrolledWindow>
                        {/* always available: each run adds (or
                        re-authorizes) one Google account */}
                        <button
                            cssClasses={["gcalSignin"]}
                            tooltipText={Gcal.accountEmails.as(a =>
                                a.length > 0 ? `Signed in: ${a.join(", ")}` : "",
                            )}
                            onClicked={() => Gcal.authenticate()}
                        >
                            <label
                                label={createComputed(
                                    [Gcal.accountEmails, Gcal.authBusy],
                                    (a, busy) =>
                                        busy
                                            ? "Waiting for sign-in…"
                                            : a.length > 0
                                              ? "+ Add Google account"
                                              : "Sign in to Google Calendar",
                                )}
                            />
                        </button>
                    </box>
                    <Gtk.Separator orientation={Gtk.Orientation.VERTICAL} />
                </box>
            ) : null}
            {monthPane}
            {Gcal.active ? (
                <box spacing={16} hexpand>
                    <Gtk.Separator orientation={Gtk.Orientation.VERTICAL} />
                    <box
                        cssClasses={["agendaPane"]}
                        orientation={Gtk.Orientation.VERTICAL}
                        spacing={8}
                        hexpand
                    >
                        <label cssClasses={["paneTitle"]} xalign={0} label={"Agenda"} />
                        <Gtk.ScrolledWindow
                            visible={Gcal.accountEmails.as(a => a.length > 0)}
                            vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
                            hscrollbarPolicy={Gtk.PolicyType.NEVER}
                            propagateNaturalHeight
                            maxContentHeight={250}
                            vexpand
                        >
                            <box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
                                <For each={agenda}>
                                    {(group: Gcal.AgendaGroup) => (
                                        <box
                                            cssClasses={["gcalAgendaGroup"]}
                                            orientation={Gtk.Orientation.VERTICAL}
                                            spacing={4}
                                        >
                                            <label
                                                cssClasses={["gcalAgendaDay"]}
                                                xalign={0}
                                                label={group.label}
                                            />
                                            {/* plain map, not For: the group's
                                            events are a static array — the
                                            outer For rebuilds the group when
                                            the agenda changes */}
                                            {group.events.map((e: Gcal.CalEvent) => (
                                                <box
                                                    cssClasses={["gcalEvent"]}
                                                    spacing={8}
                                                    // calendar color is API data,
                                                    // not theme: the only inline
                                                    // style in the shell
                                                    css={`
                                                        border-left-color: ${e.color};
                                                    `}
                                                >
                                                    <box
                                                        orientation={Gtk.Orientation.VERTICAL}
                                                        valign={Gtk.Align.START}
                                                    >
                                                        <label
                                                            xalign={0}
                                                            maxWidthChars={26}
                                                            ellipsize={Pango.EllipsizeMode.END}
                                                            tooltipText={`${e.summary} — ${e.calendarName} (${e.account})`}
                                                            label={e.summary}
                                                        />
                                                        <label
                                                            cssClasses={["gcalMeta"]}
                                                            xalign={0}
                                                            label={`${Gcal.timeLabel(e)} · ${e.calendarName}`}
                                                        />
                                                    </box>
                                                </box>
                                            ))}
                                        </box>
                                    )}
                                </For>
                                <label
                                    cssClasses={["gcalEmpty"]}
                                    xalign={0.5}
                                    visible={agenda.as(l => l.length === 0)}
                                    label={"No upcoming events"}
                                />
                            </box>
                        </Gtk.ScrolledWindow>
                    </box>
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
