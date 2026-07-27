import GObject, { register, getter, setter } from "ags/gobject"
import { monitorFile, readFileAsync } from "ags/file"
import { exec, execAsync } from "ags/process"
import { timeout } from "ags/time"
import Config from "../config"
import { setDimLevel } from "./hyprsunset"
import hyprsunset from "./hyprsunset"

const get = (args: string) => {
    try {
        return Number(exec(`brightnessctl ${args}`))
    } catch {
        return 0
    }
}
const has = (bin: string) => {
    try {
        exec(`which ${bin}`)
        return true
    } catch {
        return false
    }
}
const hasBrightnessctl = has("brightnessctl")
const hasHyprsunset = has("hyprsunset")
const screen = hasBrightnessctl ? exec(`bash -c "ls -w1 /sys/class/backlight | head -1"`) : ""

// @TODO, Use something better than this. Since if this is not set issues arise.
let kbd = exec(`bash -c "ls -w1 /sys/class/leds | grep kbd | head -1"`)
if (!kbd)
    kbd = exec(`bash -c "ls -w1 /sys/class/leds | head -1"`)

@register({ GTypeName: "Brightness" })
export default class Brightness extends GObject.Object {
    static instance: Brightness

    static get_default() {
        if (!this.instance)
            this.instance = new Brightness()

        return this.instance
    }

    #kbdMax = get(`--device ${kbd} max`)
    #kbd = get(`--device ${kbd} get`)
    #screenMax = get("max")
    #screen = hasBrightnessctl ? get("get") / (get("max") || 1) : hyprsunset.dim.get()
    // Panels without a working backlight (e.g. OLED where the sysfs
    // backlight is a dummy) are dimmed through hyprsunset gamma instead —
    // only on hyprland, where hyprctl exists
    #useGammaDim = !hasBrightnessctl && hasHyprsunset
        && Config.desktopSession === "hyprland"
    #screenIsPresent = hasBrightnessctl ? (screen != "")
        : (hasHyprsunset && Config.desktopSession === "hyprland")

    @getter(Number)
    get kbdMax() { return this.#kbdMax }

    @getter(Number)
    get kbd() { return this.#kbd }

    // @TODO, This setter is really slow.
    @setter(Number)
    set kbd(value) {
        if (value < 0 || value > this.#kbdMax)
            return

        execAsync(`brightnessctl -d ${kbd} s ${value} -q`).then(() => {
            this.#kbd = value
            this.notify("kbd")
        })
    }

    @getter(Number)
    get screen() { return this.#screen }

    @setter(Number)
    set screen(percent) {
        if (percent < 0)
            percent = 0

        // outdoor mode is a toggle, the slider stays 0-100%
        if (percent > 1)
            percent = 1

        this.#screen = percent

        if (this.#useGammaDim) {
            setDimLevel(percent)
            this.notify("screen")
            return
        }

        // dragging fires this per motion event; coalesce to one
        // trailing brightnessctl call
        this.#applyPercent = percent
        if (this.#applySource !== null) return
        this.#applySource = timeout(50, () => {
            this.#applySource = null
            const p = this.#applyPercent
            if (p === null) return
            this.#applyPercent = null
            execAsync(`brightnessctl set ${Math.floor(p * 100)}% -q`)
                .then(() => {
                    this.notify("screen")
                })
                .catch(() => { })
        })
    }

    #applyPercent: number | null = null
    #applySource: number | null = null

    @getter(Boolean)
    get screenIsPresent() { return this.#screenIsPresent };

    constructor() {
        super()

        // gamma-dim path: keep the slider's value in sync with the
        // shared dim state (quick settings, keybinds, the daemon watcher)
        if (this.#useGammaDim) {
            hyprsunset.dim.subscribe(() => {
                this.#screen = hyprsunset.dim.get()
                this.notify("screen")
            })
        }

        if (hasBrightnessctl && screen != "") {
            const screenPath = `/sys/class/backlight/${screen}/brightness`
            const kbdPath = `/sys/class/leds/${kbd}/brightness`

            monitorFile(screenPath, async f => {
                const v = await readFileAsync(f)
                this.#screen = Number(v) / this.#screenMax
                this.notify("screen")
            })

            monitorFile(kbdPath, async f => {
                const v = await readFileAsync(f)
                this.#kbd = Number(v)
                this.notify("kbd")
            })
        }
    }
}