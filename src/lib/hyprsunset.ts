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

// init from the running daemon so the slider matches reality
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

function currentTemp(): number {
    if (nightLight.get()) return Config.hyprsunset.nightTemp
    if (outdoor.get() && Config.hyprsunset.temperatureOutdoor !== null)
        return Config.hyprsunset.temperatureOutdoor
    return Config.hyprsunset.temperatureDefault
}

function applyTemp() {
    execAsync(["hyprctl", "hyprsunset", "temperature", String(currentTemp())])
        .catch(() => { })
}

// Dragging the brightness slider fires applyGamma per motion event;
// spawning hyprctl that often janks the main loop. Coalesce to one
// trailing call every 50ms — state (and the knob) still update instantly.
let gammaSource: number | null = null
let pendingGamma: number | null = null
function applyGamma() {
    pendingGamma = outdoor.get() ? OUTDOOR_GAMMA : Math.round(dim.get() * 100)
    if (gammaSource !== null) return
    gammaSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
        gammaSource = null
        if (pendingGamma === null) return GLib.SOURCE_REMOVE
        const gamma = pendingGamma
        pendingGamma = null
        execAsync(["hyprctl", "hyprsunset", "gamma", String(gamma)])
            .catch(() => { })
        return GLib.SOURCE_REMOVE
    })
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

export default { nightLight, outdoor, dim }
