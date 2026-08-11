import { execAsync, timeoutAdd, sourceRemove } from "./metrics"
import { createState } from "gnim"
import GLib from "gi://GLib?version=2.0"
import Config from "../config"
import { registerDispose } from "./lifecycle"

// Shared hyprsunset state. The daemon runs as a systemd user service
// (see ~/.config/hypr/user-config.conf), we never kill or spawn it —
// all changes go through `hyprctl hyprsunset`, which applies instantly
// with no unfiltered flash. Temperature (Night Light / outdoor mode)
// and gamma (dimming) are independent channels.
//
// Outdoor mode pushes gamma past 100% (and the outdoor temperature
// when configured) via a toggle, the brightness slider stays 0-100%.

const OUTDOOR_GAMMA = Config.hyprsunset.gammaOutdoor

export { OUTDOOR_GAMMA }

const [nightLight, setNightLight] = createState(false)
const [outdoor, setOutdoor] = createState(false)
const [dim, setDim] = createState(1) // gamma fraction, 0.05..1

// Night light backend. hyprctl (hyprland + hyprsunset daemon) is
// preferred; then gammastep (works on wlroots like sway); gsettings
// only when gnome-settings-daemon actually runs — on sway the schema
// often exists as a dependency but changes nothing.
//
// Backend detection and the initial daemon read are both ASYNC, which
// is the whole point of this block. This module sits in app.tsx's
// import graph, so the four `exec` calls it used to make at import were
// four synchronous fork+exec+waits blocking the main loop before the
// first frame — the exact cost config.ts and harvest/sync.ts each went
// out of their way to move off this path. Nothing needs an answer
// synchronously: the states carry sensible defaults and the only
// readers (the quick settings sliders, the brightness OSD) come along
// much later.
type TempBackend = "hyprctl" | "gsettings" | "gammastep" | "none"
const GSCHEMA = "org.gnome.settings-daemon.plugins.color"

// A STATE, not a plain value, and for the same reason config.ts's
// pendingUpdates is one: the gsettings probe below answers AFTER the
// quick settings have been built, and the night light toggle decides
// whether it exists at all from this. Read once, it would have been
// "none" forever on a gnome-settings-daemon session.
const [tempBackend, setTempBackend] = createState<TempBackend>("none")
export { tempBackend }

/**
 * False until the first daemon read has landed (or failed).
 *
 * Moving that read off the import path means `dim` now changes once,
 * asynchronously, shortly after startup — and to everything downstream
 * that looks exactly like the user reaching for the brightness control.
 * Two consumers have to know the difference:
 *
 * - `lib/brightness.ts` records a "previous level" on every change, and
 *   was recording the 1.0 it had snapshotted before this landed. The
 *   restore gesture then jumped a gamma-dim laptop to full brightness.
 * - `lib/osd.ts` shows a brightness banner on every change, and would
 *   pop one unprompted at login whenever startup outran its 1.5s grace.
 *
 * Both gate on this instead of guessing from timing.
 */
const [initialReadDone, setInitialReadDone] = createState(false)
export { initialReadDone }

function currentTemp(): number {
    if (nightLight.get()) return Config.hyprsunset.nightTemp
    if (outdoor.get() && Config.hyprsunset.temperatureOutdoor !== null)
        return Config.hyprsunset.temperatureOutdoor
    return Config.hyprsunset.temperatureDefault
}

let lastTempApply = 0
function applyTemp() {
    lastTempApply = Date.now()
    const nl = nightLight.get()
    switch (tempBackend.get()) {
        case "hyprctl":
            execAsync(["hyprctl", "hyprsunset", "temperature", String(currentTemp())]).catch(
                () => {},
            )
            break
        case "gsettings":
            if (nl)
                execAsync([
                    "gsettings",
                    "set",
                    GSCHEMA,
                    "night-light-temperature",
                    String(Config.hyprsunset.nightTemp),
                ]).catch(() => {})
            execAsync([
                "gsettings",
                "set",
                GSCHEMA,
                "night-light-enabled",
                nl ? "true" : "false",
            ]).catch(() => {})
            break
        case "gammastep":
            execAsync(
                nl ? ["gammastep", "-O", String(Config.hyprsunset.nightTemp)] : ["gammastep", "-x"],
            ).catch(() => {})
            break
    }
}

// Dragging the brightness slider fires applyGamma per motion event;
// spawning hyprctl that often janks the main loop. Coalesce to one
// trailing call every 50ms — state (and the knob) still update instantly.
let gammaSource: number | null = null
let pendingGamma: number | null = null
let lastApply = 0
function applyGamma() {
    pendingGamma = outdoor.get() ? OUTDOOR_GAMMA : Math.round(dim.get() * 100)
    // stamped at SCHEDULE time, not when the debounced exec fires: a
    // watcher read that resolves in between still sees the pre-apply
    // daemon value, and with lastApply unset by the pending write its
    // drift guard passes — so it claps `dim` back to the stale reading.
    // The OSD refreshes on every screen change, so every sleep-timer
    // dim spawned exactly that read; restoreDim then compared against
    // the clapped-back level and refused to restore (2026-08-11).
    lastApply = Date.now()
    if (gammaSource !== null) return
    gammaSource = timeoutAdd("hyprsunset:gammaApply", GLib.PRIORITY_DEFAULT, 50, () => {
        gammaSource = null
        if (pendingGamma === null) return GLib.SOURCE_REMOVE
        const gamma = pendingGamma
        pendingGamma = null
        execAsync(["hyprctl", "hyprsunset", "gamma", String(gamma)]).catch(() => {})
        return GLib.SOURCE_REMOVE
    })
}

// Watch the daemon for external gamma/temperature changes (keybinds,
// other tools). Skipped briefly after our own applies so a mid-drag
// read can't fight the debounced apply above. hyprland only — hyprctl
// does not exist elsewhere. 30s is enough: external changes are rare,
// and the Quick Settings popup calls this on open, so the slider never
// shows stale values where the user actually looks at them.
let watchRunning = false

/**
 * @param initial the COLD-START read, not a drift check.
 *
 * The two are not the same job and must not share guards. The steady
 * state asks "did something change this behind our back", so it ignores
 * a reading within 1 of what we last applied and skips anything within
 * 1.5s of our own write. At startup nothing has been applied and the
 * "expected" value is just the default 1.0 — so a daemon sitting at 101
 * (gamma_outdoor a shade over 100, outdoor mode left on across a
 * restart) differed by exactly 1 and was ignored, leaving the bar and
 * the slider drawing normal styling over a screen in outdoor mode.
 */
export function refreshHyprsunset(initial = false) {
    if (Config.desktopSession !== "hyprland") return
    if (watchRunning) return
    watchRunning = true
    Promise.all([
        execAsync("hyprctl hyprsunset gamma"),
        execAsync("hyprctl hyprsunset temperature"),
    ])
        .then(([gammaOut, tempOut]) => {
            const gamma = Number(gammaOut.trim())
            if (!isNaN(gamma) && gamma > 0 && (initial || Date.now() - lastApply >= 1500)) {
                const expected = outdoor.get() ? OUTDOOR_GAMMA : Math.round(dim.get() * 100)
                if (initial || Math.abs(gamma - expected) > 1) {
                    if (gamma > 100) {
                        setOutdoor(true)
                    } else {
                        setOutdoor(false)
                        setDim(gamma / 100)
                    }
                }
            }

            const temp = Number(tempOut.trim())
            if (!isNaN(temp) && temp > 0 && (initial || Date.now() - lastTempApply >= 1500)) {
                // matches the init heuristic: warm means night light is on
                const nl = temp <= 5000
                if (nl !== nightLight.get()) setNightLight(nl)
            }
        })
        .catch(() => {})
        .finally(() => {
            watchRunning = false
            // after the reads have been applied, never before: the
            // consumers gating on this must see the seeding change as
            // seeding, not as a user action
            if (initial) setInitialReadDone(true)
        })
}

// Backend detection, and the initial read on hyprland.
//
// Down HERE rather than up with the state it writes, because
// refreshHyprsunset closes over `watchRunning`, `lastApply` and
// `lastTempApply` — three `let`s declared between the two. Under ES
// module semantics reading those from above is a temporal-dead-zone
// ReferenceError; it happens not to bite today only because the
// bundler rewrites module-scope `let` to `var`, which hoists as
// `undefined` instead (checked: the module still imports cleanly with
// the call up there). That is the bundler's choice to make, not a
// property of this file, so the declarations come first.
if (Config.desktopSession === "hyprland") {
    setTempBackend("hyprctl")
    // the same two reads the 30s watch makes, but flagged as the cold
    // start so the drift guards (which exist to ignore our OWN writes)
    // do not suppress the seeding values — see refreshHyprsunset
    refreshHyprsunset(true)
} else if (GLib.find_program_in_path("gammastep")) {
    setTempBackend("gammastep")
    setInitialReadDone(true) // nothing to read; consumers are live at once
} else {
    // the schema existing proves nothing on sway, where it is often
    // pulled in as a dependency and changes nothing — the daemon has to
    // actually be running, hence the pgrep alongside it
    Promise.all([
        execAsync(`gsettings get ${GSCHEMA} night-light-enabled`),
        execAsync("pgrep -x gnome-settings-daemon"),
    ])
        .then(([enabled]) => {
            setTempBackend("gsettings")
            setNightLight(enabled.trim() === "true")
        })
        .catch(() => {}) // stays "none"
        .finally(() => setInitialReadDone(true))
}

// The watch that keeps gamma/temperature in step with changes made
// OUTSIDE the shell (someone running hyprsunset from a terminal).
//
// It used to be armed at import and run for the whole session: two
// `hyprctl` subprocesses every 30 seconds, about 5,760 spawns a day, to
// refresh a value with exactly two readers — the quick settings sliders,
// which only exist while that popup is open, and the brightness OSD,
// which reads it at the moment a key is pressed. Neither needed a timer
// running at 3am.
//
// Refcounted, like relTime's clock: the quick settings hold it while
// they are on screen, which is the only time an external change has
// anywhere to show up live. The OSD covers its own read by refreshing
// when brightness changes, so the flag self-corrects at the one other
// place it is looked at.
let watchSource = 0
let watchHolders = 0

export function acquireHyprsunsetWatch(): () => void {
    if (Config.desktopSession !== "hyprland") return () => {}
    watchHolders++
    if (!watchSource) {
        // fresh immediately rather than up to 30s late: the caller is
        // opening a window that shows this value
        refreshHyprsunset()
        watchSource = timeoutAdd("hyprsunset:watch", GLib.PRIORITY_DEFAULT, 30000, () => {
            refreshHyprsunset()
            return GLib.SOURCE_CONTINUE
        })
    }
    let released = false
    return () => {
        // a double release would strand the timer running forever
        if (released) return
        released = true
        watchHolders--
        if (watchHolders <= 0 && watchSource) {
            sourceRemove(watchSource)
            watchSource = 0
            watchHolders = 0
        }
    }
}

// convention for lib modules with long-lived sources (see AGENTS.md)
export function dispose() {
    if (watchSource) {
        sourceRemove(watchSource)
        watchSource = 0
    }
    if (gammaSource !== null) {
        sourceRemove(gammaSource)
        gammaSource = null
        pendingGamma = null
    }
}

export function setNightLightEnabled(v: boolean) {
    setNightLight(v)
    applyTemp()
}

export function setOutdoorEnabled(v: boolean) {
    setOutdoor(v)
    applyGamma()
    applyTemp()
}

export function setDimLevel(v: number) {
    // manual brightness adjustment takes back control
    if (outdoor.get()) setOutdoorEnabled(false)
    setDim(Math.min(1, Math.max(0.05, v)))
    applyGamma()
}

export default { nightLight, outdoor, dim, initialReadDone }

// tear-down entry point, run from app.tsx on shutdown (lib/lifecycle)
registerDispose("hyprsunset", dispose)
