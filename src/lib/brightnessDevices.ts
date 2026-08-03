import GLib from "gi://GLib?version=2.0"
import AstalBrightness from "gi://AstalBrightness"
import { createState } from "gnim"
import { execAsync, exec, connect, disconnect } from "./metrics"
import { parseDdcDetect, parseDdcGetvcp, parseOpenRgbList } from "./brightnessParsers"

// Peripheral brightness (keyboard backlights and friends) beyond the
// screen. Backends:
//
//   - AstalBrightness `leds` (kernel LED class): enumeration and
//     writes go through AstalBrightness, which writes via
//     systemd-logind — root-owned LEDs (e.g. tpacpi::kbd_backlight)
//     work without a udev rule. We filter the raw list: lock-key
//     indicators (capslock & co.) and platform status LEDs
//     (thinklight, micmute, …) are not brightness devices.
//   - asusctl (ASUS): asusd owns the LED and offers staged
//     `asusctl leds get/set` (off/low/med/high). AstalBrightness's
//     own watch on the sysfs LED still catches external
//     `asusctl leds next/prev` for the OSD.
//   - ddcutil (DDC/CI): external-monitor brightness via VCP feature
//     0x10. Nothing to watch — levels are cached and re-read on
//     `refreshExternal()` (pane open).
//   - OpenRGB: RGB peripherals. No brightness readback over the CLI,
//     so the level is what we last set (100% until then).

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

const [devices, setDevices] = createState<BrightnessDevice[]>([])
export { devices }

// the merged list: asus+LEDs are discovered synchronously at import;
// the async backends (ddcutil, OpenRGB) publish when their probes land
let localDevices: BrightnessDevice[] = []
let ddcDevices: BrightnessDevice[] = []
let rgbDevices: BrightnessDevice[] = []
const publish = () => setDevices([...localDevices, ...ddcDevices, ...rgbDevices])

// LED names already managed by us (asusctl or listed): OpenRGB
// exposes the same LEDs and must not duplicate them
const managedLeds: string[] = []

// bumped whenever any device's level changed outside us (file watch):
// the slider re-reads and the OSD hook fires
const [externalChange, bumpExternalChange] = createState<{ id: string; level: number } | null>(null)
export { externalChange }

// identical consecutive levels are not news
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
// listing them was a wall of noise on ThinkPads
const BACKLIGHT_LED = /kbd|keyboard|backlight|illum|aura/i

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
    // async on the watch path: a sync exec inside a notify callback
    // stalls the UI for a fork+asusd round-trip per change
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

// ---------------------------------------------------- AstalBrightness

const ab = AstalBrightness.get_default()

// notify::brightness connections on the currently enumerated LEDs;
// torn down and rebuilt on hotplug
const ledHandlers: Array<[{ disconnect(id: number): void }, number]> = []

function refreshLocal() {
    for (const [obj, id] of ledHandlers) disconnect(obj, id)
    ledHandlers.length = 0
    managedLeds.length = 0

    const asus = discoverAsusctl()
    const found: BrightnessDevice[] = []
    if (asus) found.push(asus.device)

    for (const led of ab?.leds.devices ?? []) {
        const name = led.name
        if (LOCK_LED.test(name) || !BACKLIGHT_LED.test(name)) continue
        if (led.maxBrightness <= 0) continue

        // asusctl owns the ASUS LED (staged control); AstalBrightness's
        // watch on it still catches external `asusctl leds next/prev`
        if (asus !== null && /asus/i.test(name)) {
            managedLeds.push(name)
            ledHandlers.push([
                led,
                connect(led, "notify::brightness", () =>
                    asus.refresh(() => reportExternal(asus.device.id, asus.device.level())),
                ),
            ])
            continue
        }

        managedLeds.push(name)
        if (found.some(d => d.label === prettify(name))) continue
        found.push({
            id: name,
            label: prettify(name),
            max: led.maxBrightness,
            level: () => led.brightness,
            set: (l: number) => {
                led.brightness = Math.min(1, Math.max(0, l))
            },
        })
        ledHandlers.push([
            led,
            connect(led, "notify::brightness", () => reportExternal(name, led.brightness)),
        ])
    }

    localDevices = found
    publish()
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
                    // the physical write lands seconds later (slow i2c):
                    // report our own target now so labels, the pill and
                    // the OSD follow the drag instead of looking dead
                    reportExternal(`ddc-bus${bus}`, cur / reply.max)
                },
            })
        } catch (e) {
            console.info(`brightness: ddc bus ${bus} (${label}) not manageable:`, e)
        }
    }
    ddcDevices = found
    publish()
    // levels changed since the last read (monitor OSD buttons): same
    // report path as the LED watches (open sliders + OSD)
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
                // no readback exists: report our own target so labels,
                // the pill and the OSD follow the drag (the asus/ddc
                // watches do the same for their devices)
                reportExternal(`openrgb-${d.index}`, level)
            },
        })
    }
    rgbDevices = found
    publish()
}

refreshLocal()
discoverDdc()
discoverOpenRgb()

// hotplug: rebuild the LED list when the kernel adds/removes LEDs.
// Stored separately from ledHandlers so a rebuild doesn't tear down
// the hotplug wiring itself
const listHandlers: Array<[{ disconnect(id: number): void }, number]> = []
if (ab) {
    listHandlers.push([ab.leds, connect(ab.leds, "device-appeared", () => refreshLocal())])
    listHandlers.push([ab.leds, connect(ab.leds, "device-removed", () => refreshLocal())])
}

// convention for lib modules with long-lived sources (see AGENTS.md)
export function dispose() {
    for (const [obj, id] of ledHandlers) disconnect(obj, id)
    ledHandlers.length = 0
    for (const [obj, id] of listHandlers) disconnect(obj, id)
    listHandlers.length = 0
}
