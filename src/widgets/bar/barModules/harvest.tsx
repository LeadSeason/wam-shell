import { Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import { createComputed, createState } from "gnim"
import Config from "../../../config"
import * as Harvest from "../../../lib/harvest"
import { sharing, enable as enableShareWatch } from "../../../lib/captureWatch"
import { setPopupAnchor } from "../../harvestPopup"
import CommandRegistry from "../../../lib/requestHandler"
import { timeoutAdd, sourceRemove } from "../../../lib/metrics"
import { registerDispose } from "../../../lib/lifecycle"
import { pressable } from "../../pressable"
import * as tz from "../../../lib/tz"

const registry = CommandRegistry.get_default()

// Whether the pill is shown is a question about NOW, so it reads the
// configured zone (lib/tz.ts) — the same clock the bar's time sits next
// to. With the default "auto" that is the machine's, as it always was.
function withinWorkHours(): boolean {
    const { workStart, workEnd } = Config.harvest
    if (!workStart || !workEnd) return false
    const now = tz.civil(Date.now())
    const mins = now.h * 60 + now.mi
    const [sh, sm] = workStart.split(":").map(Number)
    const [eh, em] = workEnd.split(":").map(Number)
    const start = sh * 60 + sm
    const end = eh * 60 + em
    // windows may wrap midnight ("22:00"-"06:00")
    return start <= end ? mins >= start && mins < end : mins >= start || mins < end
}

// empty work_days list = every day; otherwise the WEEKDAY (0=Sunday, the
// numbering work_days is written in) must be in it
function withinWorkDays(): boolean {
    const days = Config.harvest.workDays
    if (days.length === 0) return true
    // get_day_of_week(): 1=Monday..7=Sunday -> 0=Sunday..6=Saturday
    return days.includes(tz.now().get_day_of_week() % 7)
}

// one shared evaluation for every bar instance: re-armed to the next
// HH:MM boundary (~2 wakeups/day, not a 30s poll per monitor)
const [workHours, setWorkHours] = createState(withinWorkHours())
const [workDays, setWorkDays] = createState(withinWorkDays())

function msUntilNextBoundary(): number {
    const { workStart, workEnd } = Config.harvest
    const nowMs = Date.now()
    const today = tz.civil(nowMs)
    // today's HH:MM as an instant in the configured zone — `d.setHours`
    // on a Date would be the host's zone
    const toMs = (s: string) => {
        const [h, m] = s.split(":").map(Number)
        return tz.atMs(today.y, today.m, today.d, h, m)
    }
    const next = [workStart, workEnd]
        .map(s => (((toMs(s) - nowMs) % 86_400_000) + 86_400_000) % 86_400_000 || 86_400_000)
        .sort((a, b) => a - b)[0]
    // seconds were truncated before: the timer fired up to 59s late
    return next + 1000
}

// Both boundary timers re-arm themselves, so they live for the whole
// session and nothing else can reach them — tracked here and torn down
// in the disposer below, the convention every lib module with a
// long-lived source follows (AGENTS.md). They are armed at import rather
// than per widget, which is why the handles are module-scope too.
let workHoursSource = 0
let workDaysSource = 0

if (Config.harvest.workStart && Config.harvest.workEnd) {
    const arm = () => {
        workHoursSource = timeoutAdd(
            "harvest:workHours",
            GLib.PRIORITY_DEFAULT,
            msUntilNextBoundary(),
            () => {
                workHoursSource = 0
                setWorkHours(withinWorkHours())
                arm()
                return GLib.SOURCE_REMOVE
            },
        )
    }
    arm()
}

// day-of-week window: one re-check at each local midnight. Only armed
// when the user limits days at all — an every-day config (the default)
// needs no timer (and the perf gate counts startup timers)
// the next midnight IN THE CONFIGURED ZONE — the day the weekday test
// above reads changes there, not at the host's midnight
function msUntilMidnight(): number {
    const nowMs = Date.now()
    const today = tz.civil(nowMs)
    // d+1: tz.atMs normalises a day-of-month past the month end
    return tz.atMs(today.y, today.m, today.d + 1) - nowMs + 1000
}
const armMidnight = () => {
    workDaysSource = timeoutAdd(
        "harvest:workDays",
        GLib.PRIORITY_DEFAULT,
        msUntilMidnight(),
        () => {
            workDaysSource = 0
            setWorkDays(withinWorkDays())
            armMidnight()
            return GLib.SOURCE_REMOVE
        },
    )
}
if (Config.harvest.workDays.length > 0) armMidnight()

// idempotent, and safe when neither timer was ever armed
export function dispose() {
    if (workHoursSource) {
        sourceRemove(workHoursSource)
        workHoursSource = 0
    }
    if (workDaysSource) {
        sourceRemove(workDaysSource)
        workDaysSource = 0
    }
}

// tear-down entry point, run from app.tsx on shutdown (lib/lifecycle)
registerDispose("barHarvest", dispose)

// Harvest timer on the panel (lib/harvest). Visible while a timer runs
// or is paused (any day), idle inside work days × work hours
// (harvest.work_days / work_start / work_end), or — with
// collapse_off_days — as a bare icon on off-days (left click still
// opens the popup). Left-click opens the picker popup below the pill,
// right-click stops a running timer / resumes the last one. While
// screen sharing the entry details are masked: elapsed and the pause
// button hide too — viewers only see a blinking icon, never that a
// timer runs (.harvest.sharing styling).
export default function HarvestTimer({
    monitor,
    authoritative = false,
}: {
    monitor: Gdk.Monitor
    // panel lists are authoritative: a listed widget always renders
    authoritative?: boolean
}) {
    if (!Harvest.active) return <></>
    if (!Config.harvest.onPanel && !authoritative) return <></>
    // detection runs only once something actually masks on it
    if (Config.harvest.hideWhenScreenSharing) enableShareWatch()

    const masked = sharing.as(s => s && Config.harvest.hideWhenScreenSharing)

    const visible = createComputed(() => {
        const r = Harvest.running()
        const p = Harvest.paused()
        const wh = workHours()
        const wd = workDays()
        return r !== null || p !== null || (wh && (wd || Config.harvest.collapseOffDays))
    })
    // idle + off work_days: the pill keeps only its icon (left click
    // still opens the popup)
    const collapsed = createComputed(() => {
        const r = Harvest.running()
        const p = Harvest.paused()
        const wd = workDays()
        return Config.harvest.collapseOffDays && r === null && p === null && !wd
    })

    const label = createComputed(() => {
        const r = Harvest.running()
        const p = Harvest.paused()
        const el = Harvest.elapsed()
        const total = Harvest.dayTotal()
        return r
            ? Harvest.formatElapsed(el)
            : p
              ? Harvest.formatElapsed(p.hours * 3600)
              : Harvest.formatElapsed(total)
    })

    const resumeTarget = createComputed(() => {
        const p = Harvest.paused()
        const stopped = Harvest.recentStopped()
        const rec = Harvest.recents()
        return p ?? stopped[0] ?? rec[0] ?? null
    })

    const tooltip = createComputed(() => {
        const r = Harvest.running()
        const p = Harvest.paused()
        const t = resumeTarget()
        const m = masked()
        if (m) return r || p ? "Harvest timer (details hidden while sharing)" : "Harvest"
        if (r) return `${r.clientName} — ${r.projectName} · ${r.taskName} · right-click to stop`
        if (p)
            return `Paused: ${p.clientName} — ${p.projectName} · ${p.taskName} · right-click to resume`
        if (t) return `Right-click to resume: ${t.clientName} — ${t.projectName} · ${t.taskName}`
        return "Harvest"
    })

    const cssClasses = createComputed(() => {
        const r = Harvest.running()
        const p = Harvest.paused()
        const m = masked()
        return [
            "harvest",
            ...(m ? ["sharing"] : []),
            // running was only ever implied by the absence of the other two,
            // so it could not be styled at all
            ...(r && !m ? ["running"] : []),
            ...(p && !r ? ["paused"] : []),
            ...(r || p ? [] : ["idle"]),
        ]
    })

    let clickArea: Gtk.Box

    return (
        <box cssClasses={cssClasses} tooltipText={tooltip} visible={visible}>
            <box
                $={self => {
                    clickArea = self
                }}
            >
                {/* left click: popup below the pill, right click: stop/resume */}
                <Gtk.GestureClick
                    button={1}
                    {...pressable(() => {
                        const [, x] = clickArea.translate_coordinates(clickArea.get_root(), 0, 0)
                        setPopupAnchor({
                            x: x + clickArea.get_width() / 2,
                            monitor,
                        })
                        registry.execute(["harvest"], true)
                    })}
                />
                <Gtk.GestureClick
                    button={3}
                    onPressed={() =>
                        Harvest.running.peek() ? Harvest.stopRunning() : Harvest.resumeLast()
                    }
                />
                <box spacing={4}>
                    <image cssClasses={["harvestIcon"]} iconName="harvest-symbolic" />
                    {/* hidden while sharing: viewers must not see a timer
                    is running; sized for 10:23 so it can't shift neighbours */}
                    <label
                        widthChars={5}
                        label={label}
                        visible={createComputed(() => {
                            const m = masked()
                            const c = collapsed()
                            return !m && !c
                        })}
                    />
                </box>
            </box>
            {/* pause/resume on the panel itself; sibling of the click area so
            it doesn't trigger the popup gesture. Hidden while sharing for
            the same reason as the elapsed */}
            <button
                cssClasses={["pp"]}
                visible={createComputed(() => {
                    const r = Harvest.running()
                    const p = Harvest.paused()
                    const m = masked()
                    return (r !== null || p !== null) && !m
                })}
                tooltipText={Harvest.running.as(r => (r ? "Pause" : "Resume"))}
                sensitive={Harvest.busy.as(b => !b)}
                onClicked={() =>
                    Harvest.running.peek() ? Harvest.pauseTimer() : Harvest.resumeLast()
                }
            >
                <image
                    iconName={Harvest.running.as(r =>
                        r ? "media-playback-pause-symbolic" : "media-playback-start-symbolic",
                    )}
                />
            </button>
        </box>
    )
}
