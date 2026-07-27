import { exec, execAsync } from "ags/process"
import { createState } from "ags"
import GLib from "gi://GLib?version=2.0"
import Config from "../config"

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
// preferred; without it fall back to gsettings (GNOME) or gammastep
// (wlroots compositors like sway).
type TempBackend = "hyprctl" | "gsettings" | "gammastep" | "none"
const GSCHEMA = "org.gnome.settings-daemon.plugins.color"
const tempBackend: TempBackend = (() => {
    if (Config.desktopSession === "hyprland") return "hyprctl"
    try {
        exec(`gsettings get ${GSCHEMA} night-light-enabled`)
        return "gsettings"
    } catch { }
    try { exec("which gammastep"); return "gammastep" } catch { }
    return "none"
})()

// init from the running daemon so the slider matches reality
if (tempBackend === "hyprctl") {
    try {
        const gamma = Number(exec("hyprctl hyprsunset gamma"))
        if (!isNaN(gamma) && gamma > 0) {
            if (gamma > 100) setOutdoor(true)
            else setDim(gamma / 100)
        }
        const temp = Number(exec("hyprctl hyprsunset temperature"))
        if (!isNaN(temp)) setNightLight(temp <= 5000)
    } catch {
        // daemon not running, keep defaults
    }
} else if (tempBackend === "gsettings") {
    try {
        const enabled = exec(`gsettings get ${GSCHEMA} night-light-enabled`).trim()
        setNightLight(enabled === "true")
    } catch { }
}

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
    switch (tempBackend) {
        case "hyprctl":
            execAsync(["hyprctl", "hyprsunset", "temperature", String(currentTemp())])
                .catch(() => { })
            break
        case "gsettings":
            if (nl)
                execAsync(["gsettings", "set", GSCHEMA,
                    "night-light-temperature", String(Config.hyprsunset.nightTemp)])
                    .catch(() => { })
            execAsync(["gsettings", "set", GSCHEMA,
                "night-light-enabled", nl ? "true" : "false"])
                .catch(() => { })
            break
        case "gammastep":
            execAsync(nl
                ? ["gammastep", "-O", String(Config.hyprsunset.nightTemp)]
                : ["gammastep", "-x"])
                .catch(() => { })
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
    if (gammaSource !== null) return
    gammaSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
        gammaSource = null
        if (pendingGamma === null) return GLib.SOURCE_REMOVE
        const gamma = pendingGamma
        pendingGamma = null
        lastApply = Date.now()
        execAsync(["hyprctl", "hyprsunset", "gamma", String(gamma)])
            .catch(() => { })
        return GLib.SOURCE_REMOVE
    })
}

// Watch the daemon for external gamma/temperature changes (keybinds,
// other tools). Skipped briefly after our own applies so a mid-drag
// read can't fight the debounced apply above. hyprland only — hyprctl
// does not exist elsewhere.
let watchRunning = false
if (Config.desktopSession === "hyprland")
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
    if (watchRunning) return GLib.SOURCE_CONTINUE
    watchRunning = true
    Promise.all([
        execAsync("hyprctl hyprsunset gamma"),
        execAsync("hyprctl hyprsunset temperature"),
    ])
        .then(([gammaOut, tempOut]) => {
            const gamma = Number(gammaOut.trim())
            if (!isNaN(gamma) && gamma > 0 && Date.now() - lastApply >= 1500) {
                const expected = outdoor.get() ? OUTDOOR_GAMMA : Math.round(dim.get() * 100)
                if (Math.abs(gamma - expected) > 1) {
                    if (gamma > 100) {
                        setOutdoor(true)
                    } else {
                        setOutdoor(false)
                        setDim(gamma / 100)
                    }
                }
            }

            const temp = Number(tempOut.trim())
            if (!isNaN(temp) && temp > 0 && Date.now() - lastTempApply >= 1500) {
                // matches the init heuristic: warm means night light is on
                const nl = temp <= 5000
                if (nl !== nightLight.get()) setNightLight(nl)
            }
        })
        .catch(() => { })
        .finally(() => { watchRunning = false })
    return GLib.SOURCE_CONTINUE
})

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

export default { nightLight, outdoor, dim }
