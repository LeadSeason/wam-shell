import GObject, { register, getter, setter } from "ags/gobject"
import { exec } from "ags/process"
import { readFile } from "ags/file"
import AstalBrightness from "gi://AstalBrightness"
import Config from "../config"
import { setDimLevel } from "./hyprsunset"
import hyprsunset from "./hyprsunset"

// Backlight via the astal brightness library (systemd-logind, no
// brightnessctl or video group needed). OLED laptops expose a dummy
// backlight (nvidia_0) that ignores writes — those dim through
// hyprsunset gamma instead (hyprland only).

const ab = AstalBrightness.get_default()
const abScreen = ab?.screen ?? null // proxy for the guessed main screen
// OLED laptops expose a dummy backlight (nvidia_0) that ignores writes;
// LED devices (e.g. scrollock) can be misguessed as the screen too
const isDummy = abScreen
    ? abScreen.name.startsWith("nvidia") || /lock|kbd|keyboard/i.test(abScreen.name)
    : false
const hasBacklight = abScreen !== null && !isDummy
const hasHyprsunset = (() => {
    try { exec("which hyprsunset"); return true } catch { return false }
})()
// computed at module level: private fields can't be referenced from
// other fields' initializers
const useGammaDim = !hasBacklight && hasHyprsunset
    && Config.desktopSession === "hyprland"
const screenIsPresent = hasBacklight || useGammaDim

// the floor is the device's raw 1, not a fixed percentage
const maxBrightness = (() => {
    if (!hasBacklight) return 0
    try {
        return Number(readFile(
            `/sys/class/backlight/${abScreen.name}/max_brightness`)) || 0
    } catch {
        return 0
    }
})()

@register({ GTypeName: "Brightness" })
export default class Brightness extends GObject.Object {
    static instance: Brightness

    static get_default() {
        if (!this.instance)
            this.instance = new Brightness()

        return this.instance
    }

    #screen = hasBacklight ? abScreen.brightness : hyprsunset.dim.get()
    #useGammaDim = useGammaDim
    #screenIsPresent = screenIsPresent

    @getter(Number)
    get screen() { return this.#screen }

    @setter(Number)
    set screen(percent) {
        // outdoor mode is a toggle, the slider stays 0-100%
        if (percent > 1)
            percent = 1

        // never go fully blank: floor at the device's raw 1
        const floor = maxBrightness > 0 ? 1 / maxBrightness : 0.01
        if (percent < floor)
            percent = floor

        this.#screen = percent

        if (this.#useGammaDim) {
            setDimLevel(percent)
            this.notify("screen")
            return
        }

        if (hasBacklight) {
            abScreen.brightness = percent
            this.notify("screen")
        }
    }

    @getter(Boolean)
    get screenIsPresent() { return this.#screenIsPresent };

    constructor() {
        super()

        if (this.#useGammaDim) {
            // gamma-dim path: keep the slider's value in sync with the
            // shared dim state (quick settings, keybinds, the watcher)
            hyprsunset.dim.subscribe(() => {
                this.#screen = hyprsunset.dim.get()
                this.notify("screen")
            })
        } else if (hasBacklight) {
            // astal monitors sysfs itself
            abScreen.connect("notify::brightness", () => {
                this.#screen = abScreen.brightness
                this.notify("screen")
            })
        }
    }
}
