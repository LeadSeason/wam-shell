import GLib from "gi://GLib?version=2.0"
import AstalMpris from "gi://AstalMpris?version=0.1"
import { createState } from "gnim"
import Config from "../config"
import Brightness from "./brightness"

// Sleep timer: pauses every playing MPRIS player when it fires. The
// user picks the duration when starting (QS sleep timer dropdown).
// In-memory only — a shell restart cancels a running timer.

const mpris = AstalMpris.get_default()

// seconds left, 0 = no timer running
const [remaining, setRemaining] = createState(0)
export { remaining }

// countdown frozen with time still left
const [paused, setPaused] = createState(false)
export { paused }

let timerSource = 0

function arm() {
    timerSource = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
        if (remaining.get() <= 1) {
            fire()
            return GLib.SOURCE_REMOVE
        }
        setRemaining(remaining.get() - 1)
        return GLib.SOURCE_CONTINUE
    })
}

function disarm() {
    if (timerSource) {
        GLib.source_remove(timerSource)
        timerSource = 0
    }
}

// restore-on-extend state: the levels at the last fire. In-memory
// only, like the rest of the timer — a shell restart leaves
// brightness wherever it is and forgets the pre-dim level.
let preDimLevel: number | null = null
let dimmedToLevel: number | null = null

function fire() {
    timerSource = 0
    setRemaining(0)
    setPaused(false)
    for (const p of mpris.players) {
        if (p.playbackStatus === AstalMpris.PlaybackStatus.PLAYING && p.canPause) {
            try { p.pause() } catch (e) { console.warn("sleepTimer: pause failed:", e) }
        }
    }
    // dim to half the current brightness, never below 10%
    if (Config.sleepTimer.dim) {
        const brightness = Brightness.get_default()
        if (brightness.screenIsPresent) {
            preDimLevel = brightness.screen
            dimmedToLevel = Math.max(0.10, preDimLevel / 2)
            brightness.screen = dimmedToLevel
        }
    }
}

// extending after a fire means the user is back at the machine:
// restore the pre-dim brightness — unless they adjusted it themselves
// meanwhile (their explicit change always wins)
function restoreDim() {
    if (preDimLevel === null || dimmedToLevel === null) return
    const brightness = Brightness.get_default()
    if (brightness.screenIsPresent
        && Math.abs(brightness.screen - dimmedToLevel) < 0.02) {
        brightness.screen = preDimLevel
    }
    preDimLevel = null
    dimmedToLevel = null
}

export function startSleepTimer(minutes: number) {
    cancelSleepTimer()
    restoreDim()
    if (minutes <= 0) return
    setRemaining(minutes * 60)
    arm()
}

export function cancelSleepTimer() {
    disarm()
    setRemaining(0)
    setPaused(false)
}

export function toggleSleepTimerPause() {
    if (remaining.get() <= 0) return
    if (paused.get()) {
        setPaused(false)
        arm()
    } else {
        disarm()
        setPaused(true)
    }
}

export function formatRemaining(seconds: number): string {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}:${s.toString().padStart(2, "0")}`
}
