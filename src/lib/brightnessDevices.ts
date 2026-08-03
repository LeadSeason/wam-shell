import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { createState } from "gnim"
import { monitorFile } from "ags/file"
import { execAsync, exec } from "./metrics"

// Peripheral brightness (keyboard backlights and friends) beyond the
// screen. Two backends:
//
//   - /sys/class/leds/* (generic kernel LED class): used when the
//     brightness file is really writable by us (open-append probe —
//     a blind `test -w` lies on some setups). Lock-key indicator LEDs
//     (capslock & co.) are not brightness devices and never listed.
//   - asusctl (ASUS): the sysfs LED is root-owned on ASUS machines,
//     but asusd owns it and offers `asusctl leds get/set` (stages
//     off/low/med/high). Watching the sysfs file still catches
//     external `asusctl leds next/prev` for the OSD.
//
// Detected-but-unmanaged devices land in `unsupported` (with the
// reason) instead of being silently dropped.

export interface BrightnessDevice {
    id: string
    label: string
    // 0..1 fraction, matching the shell's brightness conventions
    level: () => number
    set(level: number): void
    // for the slider overlay: "High" for staged devices, "" otherwise
    stageLabel?: () => string
    // raw max (sysfs only); staged devices have none
    max?: number
}

export interface UnsupportedDevice {
    id: string
    reason: string
}

const [devices, setDevices] = createState<BrightnessDevice[]>([])
const [unsupported, setUnsupported] = createState<UnsupportedDevice[]>([])
export { devices, unsupported }

// bumped whenever any device's level changed outside us (file watch):
// the slider re-reads and the OSD hook fires
const [externalChange, bumpExternalChange] = createState<{ id: string; level: number } | null>(null)
export { externalChange }

// sysfs writes report in bursts; identical consecutive levels are not news
const lastExternal = new Map<string, number>()
function reportExternal(id: string, level: number) {
    if (lastExternal.get(id) === level) return
    lastExternal.set(id, level)
    bumpExternalChange({ id, level })
}

// ---------------------------------------------------------- helpers

const LOCK_LED = /^(input\d+::)?(capslock|numlock|scrolllock|compose|kana)$/
// only real backlight-type LEDs count as brightness devices: platform
// indicator LEDs (thinklight, micmute, phy0-led, power, lid_logo_dot,
// thinkvantage, …) are status lights, not "peripheral brightness", and
// listing them as unsupported was a wall of noise on ThinkPads
const BACKLIGHT_LED = /kbd|keyboard|backlight|illum|aura/i

const readInt = (path: string): number | null => {
    try {
        const v = Number(new TextDecoder().decode(GLib.file_get_contents(path)[1]).trim())
        return Number.isNaN(v) ? null : v
    } catch {
        return null
    }
}

// opening for append proves writability without changing a byte
function writable(path: string): boolean {
    try {
        const stream = Gio.File.new_for_path(path).append_to(Gio.FileCreateFlags.NONE, null)
        stream.close(null)
        return true
    } catch {
        return false
    }
}

const prettify = (name: string) =>
    name
        .replace(/::/g, " · ")
        .replace(/kbd_backlight/i, "keyboard backlight")
        .replace(/_/g, " ")

// ------------------------------------------------------------ asusctl

const ASUS_STAGES = ["off", "low", "med", "high"] as const

function discoverAsusctl(): {
    device: BrightnessDevice
    refresh: (done?: () => void) => void
} | null {
    if (GLib.find_program_in_path("asusctl") === null) return null
    const stageOf = (text: string) => {
        const m = text.toLowerCase().match(/brightness:\s*(\w+)/)
        return ASUS_STAGES.includes(m?.[1] as any) ? (m![1] as (typeof ASUS_STAGES)[number]) : null
    }
    let stage: (typeof ASUS_STAGES)[number] | null = null
    // async on the watch path: a sync exec inside a file-monitor
    // callback stalls the UI for a fork+asusd round-trip per change
    const refresh = (done?: () => void) => {
        execAsync(["asusctl", "leds", "get"])
            .then(out => {
                stage = stageOf(out.trim())
                done?.()
            })
            .catch(e => console.warn("asusctl leds get:", e))
    }
    // initial probe (sync, once): decides whether asusd answers at all
    try {
        stage = stageOf(exec(["asusctl", "leds", "get"]).trim())
    } catch {
        return null
    }
    if (stage === null) return null // asusctl exists but asusd isn't answering

    const device: BrightnessDevice = {
        id: "asusctl",
        label: "Keyboard backlight",
        level: () => (stage === null ? 0 : ASUS_STAGES.indexOf(stage) / (ASUS_STAGES.length - 1)),
        stageLabel: () => (stage === null ? "" : stage[0].toUpperCase() + stage.slice(1)),
        set: (l: number) => {
            const next =
                ASUS_STAGES[Math.max(0, Math.min(3, Math.round(l * (ASUS_STAGES.length - 1))))]
            execAsync(["asusctl", "leds", "set", next]).catch(e =>
                console.warn("asusctl leds set:", e),
            )
            stage = next
        },
    }
    return { device, refresh }
}

// ------------------------------------------------------------- sysfs

function describeSysfsLed(dir: Gio.File): {
    name: string
    bpath: string
    max: number
    ok: boolean
} | null {
    const path = dir.get_path()!
    const name = dir.get_basename()
    if (LOCK_LED.test(name) || !BACKLIGHT_LED.test(name)) return null
    const max = readInt(`${path}/max_brightness`)
    if (!max || max <= 0) return null
    return { name, bpath: `${path}/brightness`, max, ok: writable(`${path}/brightness`) }
}

// ---------------------------------------------------------- discovery

const monitors: Gio.FileMonitor[] = []

function refresh() {
    const found: BrightnessDevice[] = []
    const unsupportedList: UnsupportedDevice[] = []

    const asus = discoverAsusctl()
    if (asus) found.push(asus.device)

    try {
        const base = Gio.File.new_for_path("/sys/class/leds")
        const en = base.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
        let info: Gio.FileInfo | null
        while ((info = en.next_file(null)) !== null) {
            const child = base.get_child(info.get_name())
            const led = describeSysfsLed(child)
            if (!led) continue
            const asusManaged = asus !== null && /asus/i.test(led.name)

            if (led.ok && !asusManaged && !found.some(d => d.label === prettify(led.name))) {
                found.push({
                    id: led.name,
                    label: prettify(led.name),
                    max: led.max,
                    level: () => (readInt(led.bpath) ?? 0) / led.max,
                    set: (l: number) => {
                        try {
                            GLib.file_set_contents(led.bpath, String(Math.round(l * led.max)))
                        } catch (e) {
                            console.warn(`brightness: write ${led.bpath}:`, e)
                        }
                    },
                })
            } else if (!led.ok && !asusManaged) {
                unsupportedList.push({
                    id: led.name,
                    reason: "not writable (root-owned; needs a udev rule)",
                })
            }

            // every led gets a watch (readable suffices): asusctl
            // next/prev and other tools' sysfs writes both land here
            try {
                monitors.push(
                    monitorFile(led.bpath, () => {
                        if (asusManaged) {
                            // async refresh; report after the new stage lands
                            asus.refresh(() => reportExternal(asus.device.id, asus.device.level()))
                        } else {
                            const d = found.find(x => x.id === led.name)
                            if (d) reportExternal(d.id, d.level())
                        }
                    }),
                )
            } catch {}
        }
        en.close(null)
    } catch (e) {
        console.warn("brightness: enumerate /sys/class/leds:", e)
    }

    setDevices(found)
    setUnsupported(unsupportedList)
}

refresh()

// convention for lib modules with long-lived sources (see AGENTS.md)
export function dispose() {
    for (const m of monitors) m.cancel()
    monitors.length = 0
}
