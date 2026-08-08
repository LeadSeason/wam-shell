import { Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import { createComputed, createState } from "gnim"
import Config from "../../../config"
import * as Harvest from "../../../lib/harvest"
import { sharing, enable as enableShareWatch } from "../../../lib/screenShare"
import { setPopupAnchor } from "../../harvestPopup"
import CommandRegistry from "../../../lib/requestHandler"
import { timeoutAdd } from "../../../lib/metrics"
import { pressable } from "../../pressable"

const registry = CommandRegistry.get_default()

function withinWorkHours(): boolean {
    const { workStart, workEnd } = Config.harvest
    if (!workStart || !workEnd) return false
    const now = new Date()
    const mins = now.getHours() * 60 + now.getMinutes()
    const [sh, sm] = workStart.split(":").map(Number)
    const [eh, em] = workEnd.split(":").map(Number)
    const start = sh * 60 + sm
    const end = eh * 60 + em
    // windows may wrap midnight ("22:00"-"06:00")
    return start <= end ? mins >= start && mins < end : mins >= start || mins < end
}

// empty work_days list = every day; otherwise Date.getDay() must be in it
function withinWorkDays(): boolean {
    const days = Config.harvest.workDays
    return days.length === 0 || days.includes(new Date().getDay())
}

// one shared evaluation for every bar instance: re-armed to the next
// HH:MM boundary (~2 wakeups/day, not a 30s poll per monitor)
const [workHours, setWorkHours] = createState(withinWorkHours())
const [workDays, setWorkDays] = createState(withinWorkDays())

function msUntilNextBoundary(): number {
    const { workStart, workEnd } = Config.harvest
    const now = new Date()
    const nowMs = now.getTime()
    const toMs = (s: string) => {
        const [h, m] = s.split(":").map(Number)
        const d = new Date(now)
        d.setHours(h, m, 0, 0)
        return d.getTime()
    }
    const next = [workStart, workEnd]
        .map(s => (((toMs(s) - nowMs) % 86_400_000) + 86_400_000) % 86_400_000 || 86_400_000)
        .sort((a, b) => a - b)[0]
    // seconds were truncated before: the timer fired up to 59s late
    return next + 1000
}

if (Config.harvest.workStart && Config.harvest.workEnd) {
    const arm = () =>
        timeoutAdd("harvest:workHours", GLib.PRIORITY_DEFAULT, msUntilNextBoundary(), () => {
            setWorkHours(withinWorkHours())
            arm()
            return GLib.SOURCE_REMOVE
        })
    arm()
}

// day-of-week window: one re-check at each local midnight. Only armed
// when the user limits days at all — an every-day config (the default)
// needs no timer (and the perf gate counts startup timers)
function msUntilMidnight(): number {
    const d = new Date()
    d.setHours(24, 0, 0, 0)
    return d.getTime() - Date.now() + 1000
}
const armMidnight = () =>
    timeoutAdd("harvest:workDays", GLib.PRIORITY_DEFAULT, msUntilMidnight(), () => {
        setWorkDays(withinWorkDays())
        armMidnight()
        return GLib.SOURCE_REMOVE
    })
if (Config.harvest.workDays.length > 0) armMidnight()

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

    const visible = createComputed(
        [Harvest.running, Harvest.paused, workHours, workDays],
        // a running or paused timer always shows, on any day; the idle
        // widget exists only inside the days × hours window — or, with
        // collapse_off_days, as a bare icon on off-days
        (r, p, wh, wd) =>
            r !== null || p !== null || (wh && (wd || Config.harvest.collapseOffDays)),
    )
    // idle + off work_days: the pill keeps only its icon (left click
    // still opens the popup)
    const collapsed = createComputed(
        [Harvest.running, Harvest.paused, workDays],
        (r, p, wd) => Config.harvest.collapseOffDays && r === null && p === null && !wd,
    )

    const label = createComputed(
        [Harvest.running, Harvest.paused, Harvest.elapsed, Harvest.dayTotal],
        (r, p, el, total) =>
            r
                ? Harvest.formatElapsed(el)
                : p
                  ? Harvest.formatElapsed(p.hours * 3600)
                  : Harvest.formatElapsed(total),
    )

    const resumeTarget = createComputed(
        [Harvest.paused, Harvest.recentStopped, Harvest.recents],
        (p, stopped, rec) => p ?? stopped[0] ?? rec[0] ?? null,
    )

    const tooltip = createComputed(
        [Harvest.running, Harvest.paused, resumeTarget, masked],
        (r, p, t, m) => {
            if (m) return r || p ? "Harvest timer (details hidden while sharing)" : "Harvest"
            if (r) return `${r.clientName} — ${r.projectName} · ${r.taskName} · right-click to stop`
            if (p)
                return `Paused: ${p.clientName} — ${p.projectName} · ${p.taskName} · right-click to resume`
            if (t)
                return `Right-click to resume: ${t.clientName} — ${t.projectName} · ${t.taskName}`
            return "Harvest"
        },
    )

    const cssClasses = createComputed([Harvest.running, Harvest.paused, masked], (r, p, m) => [
        "harvest",
        ...(m ? ["sharing"] : []),
        // running was only ever implied by the absence of the other two,
        // so it could not be styled at all
        ...(r && !m ? ["running"] : []),
        ...(p && !r ? ["paused"] : []),
        ...(r || p ? [] : ["idle"]),
    ])

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
                        Harvest.running.get() ? Harvest.stopRunning() : Harvest.resumeLast()
                    }
                />
                <box spacing={4}>
                    <image cssClasses={["harvestIcon"]} iconName="harvest-symbolic" />
                    {/* hidden while sharing: viewers must not see a timer
                    is running; sized for 10:23 so it can't shift neighbours */}
                    <label
                        widthChars={5}
                        label={label}
                        visible={createComputed([masked, collapsed], (m, c) => !m && !c)}
                    />
                </box>
            </box>
            {/* pause/resume on the panel itself; sibling of the click area so
            it doesn't trigger the popup gesture. Hidden while sharing for
            the same reason as the elapsed */}
            <button
                cssClasses={["pp"]}
                visible={createComputed(
                    [Harvest.running, Harvest.paused, masked],
                    (r, p, m) => (r !== null || p !== null) && !m,
                )}
                tooltipText={Harvest.running.as(r => (r ? "Pause" : "Resume"))}
                sensitive={Harvest.busy.as(b => !b)}
                onClicked={() =>
                    Harvest.running.get() ? Harvest.pauseTimer() : Harvest.resumeLast()
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
