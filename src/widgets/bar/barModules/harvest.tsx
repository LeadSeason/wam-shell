import { Gtk, Gdk } from "ags/gtk4"
import { createComputed } from "gnim"
import { createPoll } from "ags/time"
import Config from "../../../config"
import * as Harvest from "../../../lib/harvest"
import { sharing } from "../../../lib/screenShare"
import { setPopupAnchor } from "../../harvestPopup"
import CommandRegistry from "../../../lib/requestHandler"

const registry = CommandRegistry.get_default()

// Harvest timer on the panel (lib/harvest). Visible while a timer runs,
// or idle inside work hours (harvest.work_start/work_end). Left-click
// opens the picker popup below the pill, right-click stops a running
// timer / resumes the last one. While screen sharing the entry details
// are masked: icon + elapsed stay, project/task and the real tooltip are
// hidden (.harvest.sharing for the indicator styling).
export default function HarvestTimer({ monitor, authoritative = false }: {
    monitor: Gdk.Monitor
    // panel lists are authoritative: a listed widget always renders
    authoritative?: boolean
}) {
    if (!Harvest.active) return <></>

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
        return start <= end
            ? mins >= start && mins < end
            : mins >= start || mins < end
    }

    // re-evaluate the window at its boundaries without a busy loop
    const workHours = createPoll(withinWorkHours(), 30_000, withinWorkHours)

    const masked = sharing.as(s => s && Config.harvest.maskWhenSharing)

    const visible = createComputed([Harvest.running, Harvest.paused, workHours],
        (r, p, wh) => (Config.harvest.onPanel || authoritative)
            && (r !== null || p !== null || wh))

    const label = createComputed(
        [Harvest.running, Harvest.paused, Harvest.elapsed, Harvest.dayTotal],
        (r, p, el, total) => r
            ? Harvest.formatElapsed(el)
            : p ? Harvest.formatElapsed(p.hours * 3600)
                : Harvest.formatElapsed(total))

    const resumeTarget = createComputed(
        [Harvest.paused, Harvest.recentStopped, Harvest.recents],
        (p, stopped, rec) => p ?? stopped[0] ?? rec[0] ?? null)

    const tooltip = createComputed(
        [Harvest.running, Harvest.paused, resumeTarget, masked],
        (r, p, t, m) => {
            if (m) return r || p
                ? "Harvest timer (details hidden while sharing)"
                : "Harvest"
            if (r) return `${r.clientName} — ${r.projectName} · ${r.taskName} · right-click to stop`
            if (p) return `Paused: ${p.clientName} — ${p.projectName} · ${p.taskName} · right-click to resume`
            if (t) return `Right-click to resume: ${t.clientName} — ${t.projectName} · ${t.taskName}`
            return "Harvest"
        })

    const cssClasses = createComputed([Harvest.running, Harvest.paused, masked],
        (r, p, m) => ["harvest",
            ...(m ? ["sharing"] : []),
            ...(p && !r ? ["paused"] : []),
            ...(r || p ? [] : ["idle"])])

    let clickArea: Gtk.Box

    return <box
        cssClasses={cssClasses}
        tooltipText={tooltip}
        visible={visible}
    >
        <box $={(self) => { clickArea = self }}>
            {/* left click: popup below the pill, right click: stop/resume */}
            <Gtk.GestureClick
                button={1}
                onPressed={() => {
                    const [, x] = clickArea.translate_coordinates(
                        clickArea.get_root(), 0, 0)
                    setPopupAnchor({
                        x: x + clickArea.get_width() / 2,
                        monitor,
                    })
                    registry.execute(["harvest"], true)
                }}
            />
            <Gtk.GestureClick
                button={3}
                onPressed={() => Harvest.running.get()
                    ? Harvest.stopRunning()
                    : Harvest.resumeLast()}
            />
            <box spacing={4}>
                <image cssClasses={["harvestIcon"]} iconName="harvest-symbolic" />
                {/* fixed request: h:mm must not resize the module and shift
                    neighbours as the digits change (sized for 10:23) */}
                <label widthChars={5} label={label} />
            </box>
        </box>
        {/* pause/resume on the panel itself; sibling of the click area so
            it doesn't trigger the popup gesture */}
        <button
            cssClasses={["pp"]}
            visible={createComputed([Harvest.running, Harvest.paused],
                (r, p) => r !== null || p !== null)}
            tooltipText={Harvest.running.as(r => r ? "Pause" : "Resume")}
            sensitive={Harvest.busy.as(b => !b)}
            onClicked={() => Harvest.running.get()
                ? Harvest.pauseTimer()
                : Harvest.resumeLast()}
        >
            <image iconName={Harvest.running.as(r => r
                ? "media-playback-pause-symbolic"
                : "media-playback-start-symbolic")} />
        </button>
    </box>
}
