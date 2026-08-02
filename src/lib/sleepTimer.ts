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
// to $XDG_RUNTIME_DIR/wam-shell/sleep-timer.json on every state change
// — reboots/logouts simply start empty (runtime tmpfs), which is
// exactly the intended scope. A starting shell claims a state file
// atomically (rename): a LIVE owner PID means another shell owns the
// timer, so dev + service shells can't double-fire (dim-to-half twice
// would be quarter brightness). A crashed or killed owner's PID is
// dead — the restart claims and adopts instead of dropping the timer.
// An expired deadline is never fired retroactively — the user gets one
// notification instead.

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

// our own PID, recorded in the state file so a starting shell can tell
// a live owner from a crashed one. /proc/self/stat, not a libc call
const myPid = (() => {
    try {
        const stat = new TextDecoder().decode(GLib.file_get_contents("/proc/self/stat")[1])
        return Number(stat.split(" ")[0]) || 0
    } catch {
        return 0
    }
})()

// is the recorded owner still a live shell? only gjs/ags processes
// count: a recycled PID of an unrelated process must not suppress
// adoption
function ownerAlive(pid: number): boolean {
    if (pid <= 0) return false
    if (!GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS)) return false
    try {
        const cmd = new TextDecoder().decode(GLib.file_get_contents(`/proc/${pid}/cmdline`)[1])
        return cmd.includes("gjs") || cmd.includes("ags")
    } catch {
        return true // exists but unreadable (hidepid): assume alive — never double-fire
    }
}

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
        pid: myPid,
    }
}

// written on every state change; the countdown tick alone does not
// write — the deadline is wall-clock, so nothing in the file changes
// while ticking
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
// a LIVE owner PID means a live shell owns the timer — hands off. A
// crashed owner's dead PID marks the file abandoned, so the restart
// claims and adopts it.
function loadState() {
    const file = Gio.File.new_for_path(statePath)
    let state: SleepTimerState | null = null
    try {
        const contents = GLib.file_get_contents(statePath)[1]
        state = parse(new TextDecoder().decode(contents))
    } catch {
        return // no file at all
    }
    const nowMs = Date.now()
    if (decide(state, nowMs, state !== null && ownerAlive(state.pid)) === "owned") return // a live shell owns the timer
    // atomic claim: only one starting shell can win the rename
    const claimedPath = `${statePath}.claimed`
    try {
        file.move(Gio.File.new_for_path(claimedPath), Gio.FileCopyFlags.OVERWRITE, null, null)
    } catch {
        return // already claimed elsewhere
    }
    const decision = decide(state, nowMs)
    switch (decision) {
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
            return // "owned" is impossible past the owner-pid check
    }
    // adopted: we are the owner now — leave the claim file behind by
    // writing state under the original path
    console.log(`sleepTimer: adopted "${decision}" state from a previous shell`)
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
