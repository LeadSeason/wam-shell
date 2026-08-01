import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import AstalMpris from "gi://AstalMpris?version=0.1"
import { createState } from "gnim"
import Config from "../config"
import Brightness from "./brightness"
import { timeoutAddSeconds, sourceRemove } from "./metrics"
import { SleepTimerState, serialize, parse, decide } from "./sleepTimerState"

// Sleep timer: pauses every playing MPRIS player when it fires (and
// dims, if configured). The user picks the duration when starting (QS
// sleep timer dropdown).
//
// The timer survives shell restarts: the owning shell writes its state
// to $XDG_RUNTIME_DIR/wam-shell/sleep-timer.json on every change and
// tick — reboots/logouts simply start empty (runtime tmpfs), which is
// exactly the intended scope. A starting shell claims a stale state
// file atomically (rename): a FRESH file means another live shell owns
// the timer, so dev + service shells can't double-fire (dim-to-half
// twice would be quarter brightness). An expired deadline is never
// fired retroactively — the user gets one notification instead.

const mpris = AstalMpris.get_default()

// seconds left, 0 = no timer running
const [remaining, setRemaining] = createState(0)
export { remaining }

// countdown frozen with time still left
const [paused, setPaused] = createState(false)
export { paused }

let timerSource = 0
// wall-clock deadline, null = no timer running. Ticking down a counter
// would lie: timeout callbacks don't fire while suspended and drift
// under load, so the remainder is derived from the wall clock instead
let deadline: number | null = null
// seconds left when paused; on resume the deadline is pushed out by
// this much, so the paused stretch doesn't count
let pausedSeconds = 0

// ------------------------------------------------- state persistence

const stateDir = `${GLib.get_user_runtime_dir()}/wam-shell`
const statePath = `${stateDir}/sleep-timer.json`

function currentState(): SleepTimerState {
    return {
        deadline,
        paused: paused.get(),
        pausedSeconds,
        dim:
            preDimLevel !== null && dimmedToLevel !== null
                ? { pre: preDimLevel, to: dimmedToLevel }
                : null,
    }
}

// every tick, so the mtime stays fresh as the owner's liveness beacon
function writeState() {
    try {
        GLib.mkdir_with_parents(stateDir, 0o700)
        GLib.file_set_contents(statePath, serialize(currentState()))
    } catch (e) {
        console.warn("sleepTimer: failed writing state:", e)
    }
}

function clearState() {
    try {
        Gio.File.new_for_path(statePath).delete(null)
    } catch {} // absent is fine
}

/** send a notification through the daemon (same pattern as bluetooth) */
function notify(summary: string, body: string) {
    Gio.DBus.session.call(
        "org.freedesktop.Notifications",
        "/org/freedesktop/Notifications",
        "org.freedesktop.Notifications",
        "Notify",
        new GLib.Variant("(susssasa{sv}i)", [
            "wam-shell",
            0,
            "dialog-warning-symbolic",
            summary,
            body,
            [],
            { urgency: new GLib.Variant("y", 2) },
            -1,
        ]),
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (_conn, res) => {
            try {
                Gio.DBus.session.call_finish(res)
            } catch (e) {
                console.warn("sleepTimer notify failed:", e)
            }
        },
    )
}

// adopt (or discard) a state left by a previous shell. Runs at import:
// a FRESH file means a live shell already owns the timer — hands off.
function loadState() {
    const file = Gio.File.new_for_path(statePath)
    let mtimeMs: number
    try {
        const info = file.query_info("time::modified", Gio.FileQueryInfoFlags.NONE, null)
        mtimeMs = info.get_attribute_uint64("time::modified") * 1000
    } catch {
        return // no file at all
    }
    const nowMs = Date.now()
    if (nowMs - mtimeMs < 3000) return // a live shell owns the timer
    // atomic claim: only one starting shell can win the rename
    const claimedPath = `${statePath}.claimed`
    try {
        file.move(Gio.File.new_for_path(claimedPath), Gio.FileCopyFlags.OVERWRITE, null, null)
    } catch {
        return // already claimed elsewhere
    }
    let state: SleepTimerState | null = null
    try {
        const contents = GLib.file_get_contents(claimedPath)[1]
        state = parse(new TextDecoder().decode(contents))
    } catch {}
    switch (decide(state, nowMs, null)) {
        case "empty":
            // malformed or contentless: drop the claim and move on
            try {
                Gio.File.new_for_path(claimedPath).delete(null)
            } catch {}
            return
        case "paused":
            pausedSeconds = state!.pausedSeconds
            setRemaining(pausedSeconds)
            setPaused(true)
            break
        case "live":
            deadline = state!.deadline
            tickRemaining()
            arm()
            break
        case "expired": {
            const at = GLib.DateTime.new_from_unix_local(state!.deadline! / 1000)
            notify(
                "Sleep timer expired",
                `The timer reached 0 at ${at?.format("%H:%M") ?? "??"} while wam-shell was down.`,
            )
            // the claim file, not the original path: clearState points
            // at the pre-rename location
            try {
                Gio.File.new_for_path(claimedPath).delete(null)
            } catch {}
            return
        }
        case "dim-only":
            preDimLevel = state!.dim!.pre
            dimmedToLevel = state!.dim!.to
            break
        default:
            return // "owned" is impossible past the freshness check
    }
    // adopted: we are the owner now — leave the claim file behind by
    // writing state under the original path
    writeState()
}

// ------------------------------------------------------------- timer

function tickRemaining() {
    if (deadline === null) return
    setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)))
}

function arm() {
    timerSource = timeoutAddSeconds("sleepTimer:countdown", GLib.PRIORITY_DEFAULT, 1, () => {
        // the tick only refreshes the display and checks the deadline;
        // after a suspend it simply fires late
        if (deadline === null) {
            timerSource = 0
            return GLib.SOURCE_REMOVE
        }
        if (Date.now() >= deadline) {
            fire()
            return GLib.SOURCE_REMOVE
        }
        tickRemaining()
        writeState() // keep the liveness beacon fresh
        return GLib.SOURCE_CONTINUE
    })
}

function disarm() {
    if (timerSource) {
        sourceRemove(timerSource)
        timerSource = 0
    }
}

// restore-on-extend state: the levels at the last fire. Persisted
// through fire now, so a shell restart no longer strands the user at
// the dimmed level
let preDimLevel: number | null = null
let dimmedToLevel: number | null = null

function fire() {
    timerSource = 0
    deadline = null
    setRemaining(0)
    setPaused(false)
    for (const p of mpris.players) {
        if (p.playbackStatus === AstalMpris.PlaybackStatus.PLAYING && p.canPause) {
            try {
                p.pause()
            } catch (e) {
                console.warn("sleepTimer: pause failed:", e)
            }
        }
    }
    // dim to half the current brightness, never below 10%
    if (Config.sleepTimer.dim) {
        const brightness = Brightness.get_default()
        if (brightness.screenIsPresent) {
            preDimLevel = brightness.screen
            dimmedToLevel = Math.max(0.1, preDimLevel / 2)
            brightness.screen = dimmedToLevel
        }
    }
    // keep the file: the dim state must survive a restart so the next
    // shell can still restore on extend (dim-only decision)
    writeState()
}

// extending after a fire means the user is back at the machine:
// restore the pre-dim brightness — unless they adjusted it themselves
// meanwhile (their explicit change always wins)
function restoreDim() {
    if (preDimLevel === null || dimmedToLevel === null) return
    const brightness = Brightness.get_default()
    if (brightness.screenIsPresent && Math.abs(brightness.screen - dimmedToLevel) < 0.02) {
        brightness.screen = preDimLevel
    }
    preDimLevel = null
    dimmedToLevel = null
    clearState() // dim restored (or superseded): nothing left to persist
}

export function startSleepTimer(minutes: number) {
    cancelSleepTimer()
    restoreDim()
    if (minutes <= 0) return
    deadline = Date.now() + minutes * 60_000
    tickRemaining() // show the full duration immediately, not a tick late
    arm()
    writeState()
}

export function cancelSleepTimer() {
    disarm()
    deadline = null
    setRemaining(0)
    setPaused(false)
    clearState()
}

export function toggleSleepTimerPause() {
    if (remaining.get() <= 0) return
    if (paused.get()) {
        // re-apply the frozen remainder as a fresh deadline
        deadline = Date.now() + pausedSeconds * 1000
        setPaused(false)
        arm()
    } else {
        // freeze: stash what's left, stop the tick
        pausedSeconds = remaining.get()
        disarm()
        setPaused(true)
    }
    writeState()
}

export function formatRemaining(seconds: number): string {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}:${s.toString().padStart(2, "0")}`
}

loadState()
