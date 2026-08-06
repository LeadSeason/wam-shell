import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import AstalMpris from "gi://AstalMpris?version=0.1"
import AstalWp from "gi://AstalWp?version=0.1"
import { createBinding, createState } from "gnim"
import Config from "../config"
import Brightness from "./brightness"
import { timeoutAdd, timeoutAddSeconds, sourceRemove, execAsync } from "./metrics"
import { writeFileAtomic } from "./atomicWrite"
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
// An expired deadline fires the alarm on adoption (when enabled): a
// missed wakeup is worse than a late one.

const mpris = AstalMpris.get_default()

// seconds left, 0 = no timer running
const [remaining, setRemaining] = createState(0)
export { remaining }

// countdown frozen with time still left
const [paused, setPaused] = createState(false)
export { paused }

// play the chime loop when the timer reaches 0 (pill checkbox; the
// config key is only the factory default). The checkbox is consulted
// at fire time, not at start, and persists across shell restarts,
// crashes and reboots in the cache dir — the runtime state file is
// session-scoped by design and the wrong place for a preference
const alarmPrefPath = `${Config.instanceCacheDir}/sleep-alarm.json`

function loadAlarmEnabled(): boolean {
    try {
        const v = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(alarmPrefPath)[1]))
        if (typeof v === "boolean") return v
    } catch {}
    return Config.sleepTimer.alarm
}

// file writes are fire-and-forget but must stay ordered — and the
// delete in clearState must not be overtaken by a pending write — so
// file ops chain on one queue. writeFileAtomic (temp + rename, async)
// keeps synchronous disk I/O off the main loop.
let ioQueue: Promise<unknown> = Promise.resolve()
function queueIo(what: string, fn: () => Promise<void> | void) {
    ioQueue = ioQueue.then(fn).catch(e => console.warn(`sleepTimer: failed writing ${what}:`, e))
}

const [alarmEnabled, setAlarmEnabledState] = createState(loadAlarmEnabled())
export { alarmEnabled }
export function setAlarmEnabled(v: boolean) {
    setAlarmEnabledState(v)
    try {
        GLib.mkdir_with_parents(Config.instanceCacheDir, 0o755)
    } catch (e) {
        console.warn("sleepTimer: failed writing alarm preference:", e)
    }
    queueIo("alarm preference", () => writeFileAtomic(alarmPrefPath, JSON.stringify(v)))
}

// the chime is looping right now (fired, not yet stopped)
const [alarming, setAlarming] = createState(false)
export { alarming }

// the chime loops until stopped, chaining on player exit: the loop
// self-times to any file length (15s here), a failed spawn backs off
// instead of spamming, and stop kills the in-flight player so a long
// file doesn't ring out. This alarm must not fail silently — the user
// may rely on it to wake up — so both the sound and the player have
// fallbacks, and the panel's quicksettings label blinks while it
// rings (no notification — the user finds the source on the panel)
const SOUND_CANDIDATES = [
    `${Config.instanceSrcDir}/assets/sleep-alarm.ogg`,
    "/usr/share/sounds/freedesktop/stereo/bell.oga",
    "/usr/share/sounds/freedesktop/stereo/complete.oga",
    "/usr/share/sounds/freedesktop/stereo/alarm-clock-elapsed.oga",
]
const alarmSound = SOUND_CANDIDATES.find(p => GLib.file_test(p, GLib.FileTest.EXISTS)) ?? null

const PLAYER_CANDIDATES: string[][] = [
    ["pw-play"],
    ["paplay"],
    ["canberra-gtk-play", "-f"],
    ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet"],
]
const alarmPlayer =
    PLAYER_CANDIDATES.find(argv => GLib.find_program_in_path(argv[0]) !== null) ?? null
let alarmSource = 0

// a wakeup alarm at 30% sink volume is a missed alarm: force 100% and
// unmute while ringing, restore on stop — only if the user didn't
// adjust anything themselves meanwhile. wpctl, not AstalWp: its
// defaultSpeaker can lag the real pipewire default sink (the chime
// plays through the pipewire default)
let savedAudio: { volume: number; mute: boolean } | null = null

// "Volume: 0.65" or "Volume: 0.30 [MUTED]"
async function readSinkVolume(): Promise<{ volume: number; mute: boolean } | null> {
    try {
        const out = await execAsync(["wpctl", "get-volume", "@DEFAULT_AUDIO_SINK@"])
        const m = out.match(/Volume:\s*([\d.]+)/)
        if (!m) return null
        return { volume: Number(m[1]), mute: /MUTED/.test(out) }
    } catch {
        return null
    }
}

async function forceAlarmVolume() {
    if (GLib.find_program_in_path("wpctl") === null) return
    const cur = await readSinkVolume()
    // the alarm may have been stopped while wpctl was out: don't latch
    // a saved level and force the sink for a session that's over
    if (cur === null || !alarming.get()) return
    savedAudio = cur
    if (cur.mute) execAsync(["wpctl", "set-mute", "@DEFAULT_AUDIO_SINK@", "0"]).catch(() => {})
    const target = Config.sleepTimer.alarmVolume
    if (cur.volume < target)
        execAsync(["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", String(target)]).catch(() => {})
}

async function restoreAlarmVolume() {
    if (savedAudio === null) return
    const saved = savedAudio
    savedAudio = null
    const cur = await readSinkVolume()
    if (cur === null) return
    const target = Config.sleepTimer.alarmVolume
    // restore only what we forced and the user left untouched
    if (cur.volume === target && saved.volume < target)
        execAsync(["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", String(saved.volume)]).catch(
            () => {},
        )
    if (saved.mute && !cur.mute)
        execAsync(["wpctl", "set-mute", "@DEFAULT_AUDIO_SINK@", "1"]).catch(() => {})
}

function rearmChime(failed: boolean) {
    if (!alarming.get()) return
    alarmSource = timeoutAddSeconds(
        "sleepTimer:alarm",
        GLib.PRIORITY_DEFAULT,
        failed ? 5 : 1,
        () => {
            alarmSource = 0
            loopChime()
            return GLib.SOURCE_REMOVE
        },
    )
}

// the in-flight player, kept so stop kills exactly this process —
// pkill -f on the sound basename could match unrelated players
let alarmProc: Gio.Subprocess | null = null

function loopChime() {
    if (!alarming.get() || !alarmPlayer || !alarmSound) return
    let proc: Gio.Subprocess
    try {
        proc = Gio.Subprocess.new(
            [...alarmPlayer, alarmSound],
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
        )
    } catch (e) {
        console.warn("sleepTimer alarm:", e)
        rearmChime(true)
        return
    }
    alarmProc = proc
    proc.wait_check_async(null, (p, res) => {
        let failed = false
        try {
            p?.wait_check_finish(res)
        } catch (e) {
            failed = true
            // a stop force_exit lands here too; only a mid-alarm
            // player failure is news
            if (alarming.get()) console.warn("sleepTimer alarm:", e)
        }
        if (alarmProc === p) alarmProc = null // natural exit or killed
        rearmChime(failed)
    })
}

function startAlarm() {
    if (!alarmPlayer || !alarmSound) {
        console.warn("sleepTimer: alarm enabled but no usable player/sound found")
        return
    }
    if (alarming.get()) return
    setAlarming(true)
    forceAlarmVolume()
    loopChime()
}

export function stopAlarm() {
    // the pause sweep re-mutes anything still unmuted when it ticks —
    // it must not outlive the session, whether or not a chime rang
    if (pauseSweepSource) {
        sourceRemove(pauseSweepSource)
        pauseSweepSource = 0
    }
    if (!alarming.get()) return
    setAlarming(false)
    if (alarmSource) {
        sourceRemove(alarmSource)
        alarmSource = 0
    }
    restoreAlarmVolume()
    // cut the in-flight chime instead of letting it ring out: kill
    // exactly our player, never an unrelated process
    alarmProc?.force_exit()
    unmuteStreams()
}

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
        mutedStreams: [...mutedStreams],
        pid: myPid,
    }
}

// written on every state change; the countdown tick alone does not
// write — the deadline is wall-clock, so nothing in the file changes
// while ticking
function writeState() {
    try {
        GLib.mkdir_with_parents(stateDir, 0o700)
    } catch (e) {
        console.warn("sleepTimer: failed writing state:", e)
    }
    // capture the state NOW, at call time: the queued write must
    // serialize what the caller saw, not whatever is live when it runs
    const data = serialize(currentState())
    queueIo("state", () => writeFileAtomic(statePath, data))
}

function clearState() {
    queueIo("state", () => {
        try {
            Gio.File.new_for_path(statePath).delete(null)
        } catch {} // absent is fine
    })
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

// a live shell owns the timer: this shell must not start/pause one of
// its own — that would double-fire (dim twice, two chime loops)
let foreignOwned = false

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
    if (decide(state, nowMs, state !== null && ownerAlive(state.pid)) === "owned") {
        foreignOwned = true // a live shell owns the timer
        return
    }
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
            // a missed wakeup is the worst outcome: ring now (the user
            // can stop it in one click), whenever it expired
            if (alarmEnabled.get()) startAlarm()
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
    // adopted: we are the owner now — restore the muted set too, so a
    // later stop/cancel can still unmute what the previous shell muted.
    // Leave the claim file behind by writing state under the original path
    for (const id of state?.mutedStreams ?? []) mutedStreams.add(id)
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

// convention for lib modules with long-lived sources (see AGENTS.md):
// the countdown tick. The state file is NOT touched — it is the
// restart-recovery contract, not a leak
export function dispose() {
    disarm()
    stopAlarm()
    if (pauseSweepSource) {
        sourceRemove(pauseSweepSource)
        pauseSweepSource = 0
    }
    // stream mutes are user-visible state (like the dim): left as-is,
    // only the watchers come down
    for (const un of streamUnsubs.values()) un()
    streamUnsubs.clear()
}

// restore-on-extend state: the levels at the last fire. Persisted
// through fire now, so a shell restart no longer strands the user at
// the dimmed level
let preDimLevel: number | null = null
let dimmedToLevel: number | null = null

function pauseAllPlayers() {
    // raw D-Bus Pause, not Astal's pause(): pause() silently no-ops
    // while CanPause is false, and browsers flap that capability — a
    // fire landing in a false window paused nothing and the mute
    // fallback silenced a still-running video. The bus method has no
    // client-side gate and is idempotent by spec: players that truly
    // can't pause ignore it, and the mute sweep picks those up
    for (const p of mpris.players) {
        if (p.playbackStatus !== AstalMpris.PlaybackStatus.PLAYING) continue
        const identity = p.identity
        Gio.DBus.session.call(
            p.busName,
            "/org/mpris/MediaPlayer2",
            "org.mpris.MediaPlayer2.Player",
            "Pause",
            null,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (_conn, res) => {
                try {
                    Gio.DBus.session.call_finish(res)
                } catch (e) {
                    console.warn(`sleepTimer: pause failed for ${identity}:`, e)
                }
            },
        )
    }
}

// ------------------------------------------------------ stream muting

// Some Firefox tabs lose their MPRIS interface (crashed content
// process, no MediaSession): nothing on D-Bus can pause them, but
// their audio still streams. The fallback is a sink-input mute at
// fire — only streams we muted are restored, user unmutes win, and
// streams that appear later get muted on the next sweep
const mutedStreams = new Set<number>()
const userUnmuted = new Set<number>()
const streamUnsubs = new Map<number, () => void>()

function watchStream(s: AstalWp.Stream) {
    if (streamUnsubs.has(s.id)) return
    const un = createBinding(s, "mute").subscribe(() => {
        // the user freed this stream: never re-mute it
        if (!s.mute && mutedStreams.has(s.id)) {
            mutedStreams.delete(s.id)
            userUnmuted.add(s.id)
        }
    })
    streamUnsubs.set(s.id, un)
}

// the alarm's own chime must never be muted by the sweep: the player
// stream carries the app name as its description and the sound file
// path as its name
const ALARM_PLAYER_NAMES = new Set(["pw-play", "paplay", "canberra-gtk-play", "ffplay"])
const isAlarmStream = (s: AstalWp.Stream) =>
    ALARM_PLAYER_NAMES.has(s.description) ||
    (!!alarmSound && s.name.endsWith(GLib.path_get_basename(alarmSound)))

// every title some MPRIS player wore during this fire session.
// Firefox exposes ONE player that hops to whichever tab is playing:
// the tab paused a sweep ago is no longer on the bus, and checking
// only live titles muted a tab whose pause had already landed
// (observed: resuming it after the timer played back dead quiet).
// Cleared at each fire — coverage is a per-session fact
const coveredTitles = new Set<string>()

function recordCoveredTitles() {
    for (const p of mpris.players) {
        const t = p.title ?? ""
        // ≥5 chars: a degenerate title ("a", "...") must not blanket-
        // match every stream of the session
        if (t.length >= 5) coveredTitles.add(t)
    }
}

// does this stream belong to some MPRIS player, now or earlier in the
// session? Those streams are pause's territory — muting them too
// would leave the app silenced long after the timer (the original
// always-mutes bug). Stream state cannot make this call: browsers
// keep a paused tab's stream alive in "running" node state, and
// AstalWp doesn't populate Stream.state at all (observed 0 on live
// streams). What does work: a browser stream's media.name is its tab
// title, which embeds the tab's MPRIS title — and for an app with a
// single stream, an identity↔app-name match (spotify streams as
// "Spotify" while its title is the song)
function streamHasPlayer(s: AstalWp.Stream, streams: AstalWp.Stream[]): boolean {
    const name = s.name ?? ""
    for (const title of coveredTitles) {
        if (name.includes(title)) return true
    }
    const app = (s.description ?? "").toLowerCase()
    if (app.length === 0) return false
    if (streams.filter(o => o.description === s.description).length !== 1) return false
    return mpris.players.some(p => {
        const identity = (p.identity ?? "").toLowerCase()
        return identity.length > 0 && (identity.includes(app) || app.includes(identity))
    })
}

function muteActiveStreams() {
    const audio = AstalWp.get_default()?.audio
    if (!audio) return
    const streams = audio.streams ?? []
    recordCoveredTitles()
    let changed = false
    for (const s of streams) {
        // hand a muted stream back to pause: when the hopping player
        // reached it and the pause landed, it is silent twice over —
        // drop our mute, or a manual resume days later starts dead
        // quiet (the mute otherwise only lifts on cancel/alarm stop)
        if (mutedStreams.has(s.id)) {
            const pausedCover = mpris.players.some(p => {
                const t = p.title ?? ""
                return (
                    t.length >= 5 &&
                    (s.name ?? "").includes(t) &&
                    p.playbackStatus !== AstalMpris.PlaybackStatus.PLAYING
                )
            })
            if (pausedCover) {
                mutedStreams.delete(s.id)
                changed = true
                execAsync(["wpctl", "set-mute", String(s.id), "0"]).catch(() => {})
            }
            continue
        }
        if (s.mute || userUnmuted.has(s.id) || isAlarmStream(s)) continue
        // the fallback is only for what pause cannot reach: media with
        // no MPRIS interface (e.g. the second playing firefox tab —
        // firefox exposes a single player for one tab at a time)
        if (streamHasPlayer(s, streams)) continue
        // wpctl, not the endpoint property: the property write races
        // (observed landing for one stream and silently not for another)
        execAsync(["wpctl", "set-mute", String(s.id), "1"]).catch(() => {})
        mutedStreams.add(s.id)
        changed = true
        watchStream(s)
    }
    // a restart must be able to unmute what we just muted (or stop
    // trying to unmute what pause took over)
    if (changed) writeState()
}

function unmuteStreams() {
    for (const id of mutedStreams) execAsync(["wpctl", "set-mute", String(id), "0"]).catch(() => {})
    mutedStreams.clear()
    userUnmuted.clear()
    for (const un of streamUnsubs.values()) un()
    streamUnsubs.clear()
    writeState()
}

// multi-player fireboxes leave tabs audible after one sweep: a player
// can be mid-buffering (paused for an instant), racing the fire, or
// re-created under a fresh bus name just after it — and firefox's
// hopping player pauses only one tab per pass, moving to the next
// playing tab once the previous pause lands. Re-sweep three times,
// re-reading the player and stream lists each time, then log whatever
// survives — the re-runs also catch playerless streams that appeared
// after the fire, and give the mute→pause handback a tick after the
// last cascading pause
let pauseSweepSource = 0
function armPauseSweep() {
    if (pauseSweepSource) sourceRemove(pauseSweepSource)
    let sweep = 0
    pauseSweepSource = timeoutAdd("sleepTimer:pauseSweep", GLib.PRIORITY_DEFAULT, 1500, () => {
        pauseAllPlayers()
        muteActiveStreams()
        if (++sweep < 3) return GLib.SOURCE_CONTINUE
        pauseSweepSource = 0
        const left = mpris.players.filter(
            p => p.playbackStatus === AstalMpris.PlaybackStatus.PLAYING,
        )
        if (left.length > 0)
            console.warn(
                `sleepTimer: still playing after pauses: ${left.map(p => p.identity).join(", ")}`,
            )
        return GLib.SOURCE_REMOVE
    })
}

function fire() {
    timerSource = 0
    deadline = null
    setRemaining(0)
    setPaused(false)
    coveredTitles.clear() // coverage is per fire session
    pauseAllPlayers()
    // what has no MPRIS interface can't be paused — mute it instead.
    // Streams covered by a player are skipped: their pause is already
    // in flight, and muting them too would leave the app silenced
    // long after the timer
    muteActiveStreams()
    armPauseSweep()
    // dim to half the current brightness, never below 10%
    if (Config.sleepTimer.dim) {
        const brightness = Brightness.get_default()
        if (brightness.screenIsPresent) {
            preDimLevel = brightness.screen
            dimmedToLevel = Math.max(
                Config.sleepTimer.dimFloor,
                preDimLevel * Config.sleepTimer.dimLevel,
            )
            brightness.screen = dimmedToLevel
        }
    }
    // keep the file: the dim state must survive a restart so the next
    // shell can still restore on extend (dim-only decision)
    writeState()
    if (alarmEnabled.get()) startAlarm()
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
    if (foreignOwned) return // a stale-but-live timer belongs to the other shell instance
    cancelSleepTimer()
    restoreDim()
    stopAlarm()
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
    stopAlarm()
    unmuteStreams()
    clearState()
}

export function toggleSleepTimerPause() {
    if (foreignOwned || remaining.get() <= 0) return
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
