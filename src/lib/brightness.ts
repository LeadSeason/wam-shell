import GObject, { register, getter, setter } from "ags/gobject"
import GLib from "gi://GLib?version=2.0"
import { connect, disconnect, timeoutAdd, sourceRemove } from "./metrics"
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

// a real backlight must have a readable max in sysfs — an empty
// /sys/class/backlight can still leave a phantom proxy
const readMax = (): number => {
    if (!abScreen || isDummy) return 0
    try {
        return Number(readFile(`/sys/class/backlight/${abScreen.name}/max_brightness`)) || 0
    } catch {
        return 0
    }
}
const maxBrightness = readMax()
const hasBacklight = abScreen !== null && !isDummy && maxBrightness > 0
const hasHyprsunset = GLib.find_program_in_path("hyprsunset") !== null
// computed at module level: private fields can't be referenced from
// other fields' initializers
const useGammaDim = !hasBacklight && hasHyprsunset && Config.desktopSession === "hyprland"
const screenIsPresent = hasBacklight || useGammaDim

@register({ GTypeName: "Brightness" })
export default class Brightness extends GObject.Object {
    static instance: Brightness

    static get_default() {
        if (!this.instance) this.instance = new Brightness()

        return this.instance
    }

    #screen = hasBacklight ? abScreen.brightness : hyprsunset.dim.get()
    #useGammaDim = useGammaDim
    #screenIsPresent = screenIsPresent
    // last level before the most recent change, -1 = none yet
    #previous = -1

    @getter(Number)
    get screen() {
        return this.#screen
    }

    @getter(Number)
    get previous() {
        return this.#previous
    }

    /** jump back to the previous level; the tracking hook then holds
     *  the level we just left, so this toggles between the two */
    restorePrevious() {
        if (this.#previous < 0) return
        this.screen = this.#previous
    }

    @setter(Number)
    set screen(fraction) {
        // no backlight and no gamma backend: nothing consumes the
        // value — writing #screen without notify would only drift
        // bound widgets away from the real level
        if (!this.#screenIsPresent) return

        // outdoor mode is a toggle, the slider stays 0-100%
        if (fraction > 1) fraction = 1

        // never go fully blank: floor at the device's raw 1
        const floor = maxBrightness > 0 ? 1 / maxBrightness : 0.01
        if (fraction < floor) fraction = floor

        this.#screen = fraction

        if (this.#useGammaDim) {
            setDimLevel(fraction)
            // setDimLevel clamps to 0.05: when our target sat below the
            // clamp, the real gamma wins — show the clamped value, not
            // the unclamped request
            this.#screen = hyprsunset.dim.get()
            this.notify("screen")
            return
        }

        if (hasBacklight) {
            abScreen.brightness = fraction
            this.notify("screen")
        }
    }

    @getter(Boolean)
    get screenIsPresent() {
        return this.#screenIsPresent
    }

    constructor() {
        super()

        // remember the level before every effective change (slider,
        // scroll, keybinds, sleep-timer dim) for restorePrevious().
        // Epsilon-guarded: after a write, the astal/sysfs read-back
        // fires again with the raw-quantized value (±1 raw step) and
        // must not register as a new change, or it clobbers previous
        // with the value the user just set. Sub-epsilon changes keep
        // accumulating into the next significant one (last is not
        // advanced on noise). The snapshot is debounced: a slider drag
        // fires per motion event, so `previous` is only recorded once
        // the changes settle — it always holds the pre-drag level.
        const eps = maxBrightness > 0 ? Math.min(0.03, 1.5 / maxBrightness) : 0.02
        let last = this.#screen
        let burstStart = -1
        this.#screenHandler = connect(this, "notify::screen", () => {
            // The gamma-dim path seeds `dim` from an async daemon read
            // that lands AFTER this object was constructed, so #screen
            // and `last` above were both the 1.0 default. That seeding
            // change is not a user action: recording it made `previous`
            // a 100% nobody set, and the restore gesture then took a
            // 60%-gamma laptop to full brightness. Adopt the value and
            // move on — the real pre-change level is whatever it seeds to
            if (this.#useGammaDim && !hyprsunset.initialReadDone.get()) {
                last = this.#screen
                return
            }
            if (Math.abs(this.#screen - last) < eps) return
            if (this.#settleSource === 0) burstStart = last
            if (this.#settleSource !== 0) sourceRemove(this.#settleSource)
            this.#settleSource = timeoutAdd(
                "brightness:previousSettle",
                GLib.PRIORITY_DEFAULT,
                200,
                () => {
                    this.#settleSource = 0
                    this.#previous = burstStart
                    last = this.#screen
                    this.notify("previous")
                    return GLib.SOURCE_REMOVE
                },
            )
        })

        if (this.#useGammaDim) {
            // gamma-dim path: keep the slider's value in sync with the
            // shared dim state (quick settings, keybinds, the watcher)
            this.#dimUnsub = hyprsunset.dim.subscribe(() => {
                this.#screen = hyprsunset.dim.get()
                this.notify("screen")
            })
        } else if (hasBacklight) {
            // astal monitors sysfs itself
            this.#abHandler = connect(abScreen, "notify::brightness", () => {
                this.#screen = abScreen.brightness
                this.notify("screen")
            })
        }
    }

    // convention for lib modules with long-lived sources (see AGENTS.md)
    #screenHandler = 0
    #abHandler = 0
    #dimUnsub: (() => void) | null = null
    #settleSource = 0

    dispose() {
        if (this.#screenHandler) {
            disconnect(this, this.#screenHandler)
            this.#screenHandler = 0
        }
        if (this.#abHandler) {
            disconnect(abScreen, this.#abHandler)
            this.#abHandler = 0
        }
        this.#dimUnsub?.()
        this.#dimUnsub = null
        if (this.#settleSource !== 0) {
            sourceRemove(this.#settleSource)
            this.#settleSource = 0
        }
    }
}
