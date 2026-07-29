import GLib from "gi://GLib?version=2.0"
import AstalMpris from "gi://AstalMpris?version=0.1"
import { createState } from "gnim"

// Sleep timer: pauses every playing MPRIS player when it fires. The
// user picks the duration when starting (QS sleep timer dropdown).
// In-memory only — a shell restart cancels a running timer.

const mpris = AstalMpris.get_default()

// seconds left, 0 = no timer running
const [remaining, setRemaining] = createState(0)
export { remaining }

let timerSource = 0

function fire() {
    timerSource = 0
    setRemaining(0)
    for (const p of mpris.players) {
        if (p.playbackStatus === AstalMpris.PlaybackStatus.PLAYING && p.canPause) {
            try { p.pause() } catch (e) { console.warn("sleepTimer: pause failed:", e) }
        }
    }
}

export function startSleepTimer(minutes: number) {
    cancelSleepTimer()
    if (minutes <= 0) return
    setRemaining(minutes * 60)
    timerSource = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
        if (remaining.get() <= 1) {
            fire()
            return GLib.SOURCE_REMOVE
        }
        setRemaining(remaining.get() - 1)
        return GLib.SOURCE_CONTINUE
    })
}

export function cancelSleepTimer() {
    if (timerSource) {
        GLib.source_remove(timerSource)
        timerSource = 0
    }
    setRemaining(0)
}

export function formatRemaining(seconds: number): string {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}:${s.toString().padStart(2, "0")}`
}
