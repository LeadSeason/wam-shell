import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { createState } from "gnim"
import { monitorFile } from "ags/file"
import { execAsync, exec } from "./metrics"
import { parseDdcDetect, parseDdcGetvcp, parseOpenRgbList } from "./brightnessParsers"

// Peripheral brightness (keyboard backlights and friends) beyond the
// screen. Backends:
//
//   - /sys/class/leds/* (generic kernel LED class): used when the
//     brightness file is really writable by us (open-append probe —
//     a blind `test -w` lies on some setups). Lock-key indicator LEDs
//     (capslock & co.) are not brightness devices and never listed.
//   - asusctl (ASUS): the sysfs LED is root-owned on ASUS machines,
//     but asusd owns it and offers `asusctl leds get/set` (stages
//     off/low/med/high). Watching the sysfs file still catches
//     external `asusctl leds next/prev` for the OSD.
//   - ddcutil (DDC/CI): external-monitor brightness via VCP feature
//     0x10. Nothing to watch — levels are cached and re-read on
//     `refreshExternal()` (pane open).
//   - OpenRGB: RGB peripherals. No brightness readback over the CLI,
//     so the level is what we last set (100% until then).
//
// Detected-but-unmanaged devices are logged (with the reason) instead
// of being silently dropped — not shown in the GUI.

export interface BrightnessDevice {
    id: string
    label: string
    // symbolic icon for the pane row and the OSD (default: keyboard)
    icon?: string
    // 0..1 fraction, matching the shell's brightness conventions
    level: () => number
    set(level: number): void
    // for the slider overlay: "High" for staged devices, "" otherwise
    stageLabel?: () => string
    // display labels of every stage (staged devices only, e.g. asusctl's
    // ["Off", "Low", "Med", "High"]): the pane renders them as one-tap
    // buttons. stage i maps to set(i / (stages.length - 1))
    stages?: string[]
    // raw max (sysfs/ddc only); staged devices have none
    max?: number
}

interface UnsupportedDevice {
    id: string
    reason: string
}

const [devices, setDevices] = createState<BrightnessDevice[]>([])
export { devices }

// the merged list: asus+sysfs are discovered synchronously at import;
// the async backends (ddcutil, OpenRGB) publish when their probes land
let localDevices: BrightnessDevice[] = []
let ddcDevices: BrightnessDevice[] = []
let rgbDevices: BrightnessDevice[] = []
const publish = () => setDevices([...localDevices, ...ddcDevices, ...rgbDevices])

// sysfs LED names already managed by us (asusctl or writable sysfs):
// OpenRGB exposes the same LEDs and must not duplicate them
const managedLeds: string[] = []

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
const ASUS_STAGE_LABELS = ASUS_STAGES.map(s => s[0].toUpperCase() + s.slice(1))

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
        stages: ASUS_STAGE_LABELS,
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
    managedLeds.length = 0

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
                managedLeds.push(led.name)
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
            } else if (asusManaged) {
                managedLeds.push(led.name)
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

    localDevices = found
    publish()
    if (unsupportedList.length > 0)
        console.info(
            `brightness: unsupported devices: ${unsupportedList.map(x => `${x.id} (${x.reason})`).join(", ")}`,
        )
}

// ---------------------------------------------------------- ddcutil

// External-monitor brightness over DDC/CI (VCP feature 0x10). Fully
// async — detection probes every i2c bus and takes seconds. Levels are
// cached; re-read on refreshExternal() since there is nothing to watch.

const hasDdcutil = GLib.find_program_in_path("ddcutil") !== null

async function discoverDdc() {
    if (!hasDdcutil) return
    let parsed: ReturnType<typeof parseDdcDetect>
    try {
        parsed = parseDdcDetect(await execAsync(["ddcutil", "detect", "--brief"]))
    } catch (e) {
        console.info("brightness: ddcutil detect:", e)
        return
    }
    // identical models get a bus suffix so two of the same monitor
    // don't render as twins
    const counts = new Map<string, number>()
    for (const d of parsed) counts.set(d.label, (counts.get(d.label) ?? 0) + 1)

    const previous = new Map(ddcDevices.map(d => [d.id, d.level()]))
    const found: BrightnessDevice[] = []
    for (const { bus, label } of parsed) {
        try {
            const reply = parseDdcGetvcp(
                await execAsync(["ddcutil", "getvcp", "10", "--bus", String(bus), "--brief"]),
            )
            if (!reply) throw new Error("no usable VCP 10 reply")
            let cur = reply.cur
            // serialized, latest-value-wins: an unthrottled setvcp per
            // slider tick crashed a monitor's DDC/CI firmware (Acer
            // X34P): dozens of overlapping writes per drag
            let pending: number | null = null
            let inflight = false
            const send = (): void => {
                if (inflight || pending === null) return
                const v = pending
                pending = null
                inflight = true
                execAsync([
                    "ddcutil",
                    "setvcp",
                    "10",
                    String(v),
                    "--bus",
                    String(bus),
                    "--noverify",
                ])
                    .catch(e => console.warn(`ddcutil setvcp (bus ${bus}):`, e))
                    .finally(() => {
                        inflight = false
                        send()
                    })
            }
            found.push({
                id: `ddc-bus${bus}`,
                label: (counts.get(label) ?? 0) > 1 ? `${label} #${bus}` : label,
                icon: "video-display-symbolic",
                max: reply.max,
                level: () => cur / reply.max,
                set: (l: number) => {
                    cur = Math.round(Math.min(1, Math.max(0, l)) * reply.max)
                    pending = cur
                    send()
                },
            })
        } catch (e) {
            console.info(`brightness: ddc bus ${bus} (${label}) not manageable:`, e)
        }
    }
    ddcDevices = found
    publish()
    // levels changed since the last read (monitor OSD buttons): same
    // report path as the sysfs watches (open sliders + OSD)
    for (const d of found) {
        const prev = previous.get(d.id)
        if (prev !== undefined && prev !== d.level()) reportExternal(d.id, d.level())
    }
}

// re-read the backends that have nothing to watch (ddc); called when
// the peripherals pane opens
export function refreshExternal() {
    discoverDdc()
}

// ---------------------------------------------------------- OpenRGB

// RGB peripherals via the OpenRGB CLI. Two CLI limitations shape the
// design: brightness is mode-scoped and cannot be read back (the level
// is what we last set, 100% until then), and every invocation re-probes
// all hardware (seconds) — so sets are serialized per device with
// latest-value-wins, which keeps slider drags from spawning a flock of
// multi-second probes.

const hasOpenRgb = GLib.find_program_in_path("openrgb") !== null

async function discoverOpenRgb() {
    if (!hasOpenRgb) return
    let text: string
    try {
        text = await execAsync(["openrgb", "--list-devices", "--noautoconnect"])
    } catch (e) {
        console.info("brightness: openrgb probe:", e)
        return
    }
    const found: BrightnessDevice[] = []
    for (const d of parseOpenRgbList(text)) {
        // OpenRGB also exposes kernel backlight LEDs we already manage
        // (e.g. the asus::kbd_backlight asusctl owns) — skip those
        if (managedLeds.some(n => d.location.includes(`/leds/${n}`))) continue
        let level = 1
        let pending: number | null = null
        let inflight = false
        const send = (): void => {
            if (inflight || pending === null) return
            const v = Math.round(pending * 100)
            pending = null
            inflight = true
            execAsync(["openrgb", "-d", String(d.index), "-b", String(v), "--noautoconnect"])
                .catch(e => console.warn(`openrgb set ${d.name}:`, e))
                .finally(() => {
                    inflight = false
                    send()
                })
        }
        found.push({
            id: `openrgb-${d.index}`,
            label: d.name,
            icon:
                /mouse/i.test(d.type) || /mouse/i.test(d.name)
                    ? "input-mouse-symbolic"
                    : "input-keyboard-symbolic",
            level: () => level,
            set: (l: number) => {
                level = Math.min(1, Math.max(0, l))
                pending = level
                send()
            },
        })
    }
    rgbDevices = found
    publish()
}

refresh()
discoverDdc()
discoverOpenRgb()

// convention for lib modules with long-lived sources (see AGENTS.md)
export function dispose() {
    for (const m of monitors) m.cancel()
    monitors.length = 0
}
