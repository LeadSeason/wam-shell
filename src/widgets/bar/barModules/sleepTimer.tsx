import { Gtk } from "ags/gtk4"
import { createComputed } from "gnim"
import Config from "../../../config"
import { formatRemaining, paused, remaining, toggleSleepTimerPause } from "../../../lib/sleepTimer"

// Sleep timer countdown (lib/sleepTimer). Only visible while a timer
// is running (and sleep_timer.on_panel is on), so it costs no panel
// space otherwise. Click pauses / resumes the countdown.
export default function SleepTimer() {
    return (
        <button
            cssClasses={createComputed([remaining, paused], (s, p) => [
                "sleepTimer",
                ...(s > 0 && p ? ["paused"] : []),
            ])}
            tooltipText={paused.as(p => (p ? "Resume the sleep timer" : "Pause the sleep timer"))}
            visible={remaining.as(s => s > 0 && Config.sleepTimer.onPanel)}
            onClicked={() => toggleSleepTimerPause()}
        >
            <box spacing={4}>
                <image iconName="alarm-symbolic" />
                {/* fixed request: mm:ss must not resize the module and
                shift neighbours as the digits change (custom timers
                above 99 minutes may still grow past it) */}
                <label widthChars={5} label={remaining.as(formatRemaining)} />
            </box>
        </button>
    )
}
