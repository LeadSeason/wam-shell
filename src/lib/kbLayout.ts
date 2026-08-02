import { Accessor, createState } from "gnim"
import Gdk from "gi://Gdk?version=4.0"
import { execAsync, connect, disconnect } from "./metrics"
import { createPoll } from "ags/time"
import { readFile } from "ags/file"
import AstalHyprland from "gi://AstalHyprland"
import Config from "../config"
import { watchSwayInputs, unwatchSwayInputs } from "./swayInput"

// Shared keyboard layout source. The bar dropdown and the OSD both
// consume it; it runs when either exists, independent of panel config.

// xkb codes that are not ISO country codes
const FLAG_OVERRIDES: Record<string, string> = {
    ara: "🇮🇶", // Arabic
    latam: "🌎", // Latin American, no single country
    epo: "🟩", // Esperanto, green like its flag
}

export function flag(code: string): string {
    if (code in FLAG_OVERRIDES) return FLAG_OVERRIDES[code]
    if (/^[a-z]{2}$/.test(code))
        return String.fromCodePoint(...[...code].map(c => 0x1f1e6 + c.charCodeAt(0) - 97))
    return ""
}

// layout code -> description from the system's xkb database
function loadXkbNames(): Record<string, string> {
    try {
        const xml = readFile("/usr/share/X11/xkb/rules/evdev.xml")
        const names: Record<string, string> = {}
        for (const m of xml.matchAll(/<layout>([\s\S]*?)<\/layout>/g)) {
            const name = m[1].match(/<name>([^<]+)<\/name>/)?.[1]
            const desc = m[1].match(/<description>([^<]+)<\/description>/)?.[1]
            if (name && desc) names[name] = desc
        }
        return names
    } catch (e) {
        console.error("keyboard layout: failed reading evdev.xml:", e)
        return {}
    }
}

// parsed on first use, not at import: the file is ~1MB of XML and a
// session may never render a layout name
let xkbNamesCache: Record<string, string> | null = null
function getXkbNames(): Record<string, string> {
    if (xkbNamesCache === null) xkbNamesCache = loadXkbNames()
    return xkbNamesCache
}

export interface LayoutSource {
    layouts: Accessor<string[]> // xkb codes ("" when unknown)
    names: Accessor<string[]> // display name per index
    activeIndex: Accessor<number>
    switchTo(i: number): void
}

// fed by the backends on layout change; the OSD shows it
export const [layoutOsdText, setLayoutOsdText] = createState("")

// caps/num lock state from the GDK keyboard device: GDK4 exposes it
// directly (notify::caps/num-lock-state) on any compositor, so unlike
// the layout name it needs no hyprctl/swaymsg read. null before the
// first read.
export const [lockKeyState, setLockKeyState] = createState<{ caps: boolean; num: boolean } | null>(
    null,
)

let lockSourceStarted = false
// tracked so dispose() can disconnect (metrics disconnect needs the
// object the handler id belongs to)
let lockKb: Gdk.Device | null = null
let lockHandlerIds: number[] = []

// connect once; the seat's keyboard device lives for the whole session
export function ensureLockSource(): void {
    if (lockSourceStarted) return
    lockSourceStarted = true
    const kb = Gdk.Display.get_default()?.get_default_seat()?.get_keyboard()
    if (!kb) {
        console.error("lock keys: no GDK keyboard device")
        return
    }
    const read = () => setLockKeyState({ caps: kb.capsLockState, num: kb.numLockState })
    read() // the signals only fire on change, so seed the initial state
    lockKb = kb
    lockHandlerIds = [
        connect(kb, "notify::caps-lock-state", read),
        connect(kb, "notify::num-lock-state", read),
    ]
}

function hyprlandSource(): LayoutSource {
    const hyprland = AstalHyprland.get_default()
    const [layouts, setLayouts] = createState<string[]>([])
    const [variants, setVariants] = createState<string[]>([])
    const [activeIndex, setActiveIndex] = createState(0)
    let mainKb = ""

    function refresh() {
        execAsync("hyprctl devices -j")
            .then(out => {
                const devices = JSON.parse(out)
                const kb = devices.keyboards.find((k: any) => k.main) ?? devices.keyboards[0]
                if (!kb) return
                mainKb = kb.name
                const codes = kb.layout.split(",").map((s: string) => s.trim())
                setLayouts(codes)
                setVariants((kb.variant ?? "").split(",").map((s: string) => s.trim()))
                setActiveIndex(kb.active_layout_index)
                if (kb.active_layout_index === lastIndex) return
                const wasFirst = lastIndex === null
                lastIndex = kb.active_layout_index
                if (wasFirst) return
                const code = codes[kb.active_layout_index] ?? ""
                const base = getXkbNames()[code] ?? code.toUpperCase()
                setLayoutOsdText(`${flag(code)} ${base}`.trim())
            })
            .catch(e => console.error("keyboard layout:", e))
    }

    let lastIndex: number | null = null
    refresh()
    // the keyboard-layout signal covers layout switches; lock keys come
    // from GDK (ensureLockSource), so no recurring hyprctl poll is needed
    hyprlandObj = hyprland
    hyprlandLayoutHandler = connect(hyprland, "keyboard-layout", refresh)

    return {
        layouts,
        names: layouts.as(ls =>
            ls.map((code, i) => {
                const base = getXkbNames()[code] ?? code.toUpperCase()
                const v = variants.get()[i]
                return v ? `${base} (${v})` : base
            }),
        ),
        activeIndex,
        switchTo(i) {
            if (mainKb)
                execAsync(["hyprctl", "switchxkblayout", mainKb, String(i)]).catch(e =>
                    console.error("keyboard layout:", e),
                )
        },
    }
}

function swaySource(msgCmd: string): LayoutSource {
    // sway gives layout descriptions, not codes; reverse the xkb db.
    // built on first use — the input stream below is the first consumer
    let descToCode: Record<string, string> | null = null
    function codeFor(desc: string): string {
        if (descToCode === null) {
            const map: Record<string, string> = {}
            for (const [code, d] of Object.entries(getXkbNames())) if (!(d in map)) map[d] = code
            descToCode = map
        }
        return descToCode[desc] ?? ""
    }

    const [layouts, setLayouts] = createState<string[]>([])
    const [names, setNames] = createState<string[]>([])
    const [activeIndex, setActiveIndex] = createState(0)
    let identifier = ""
    let prevIndex: number | null = null

    function applyKeyboard(kb: any) {
        identifier = kb.identifier
        const ns = kb.xkb_layout_names as string[]
        setNames(ns)
        setLayouts(ns.map(n => codeFor(n)))
        const idx = kb.xkb_active_layout_index ?? 0
        setActiveIndex(idx)
        if (prevIndex !== null && idx !== prevIndex) {
            const code = codeFor(ns[idx])
            setLayoutOsdText(`${flag(code)} ${ns[idx]}`.trim())
        }
        prevIndex = idx
    }

    function applyInputs(inputs: any[]) {
        const kb = inputs.find((k: any) => k.type === "keyboard" && k.xkb_layout_names?.length > 0)
        if (kb) applyKeyboard(kb)
    }

    // the 10s swaymsg poll, only as a fallback: spawns swaymsg/i3msg for
    // the shell's lifetime when the raw IPC stream is unavailable
    function startPollFallback() {
        const poll = createPoll("", 10000, async () => {
            // swallow failures (binary missing, IPC down): keep old value
            try {
                return await execAsync(`${msgCmd} -t get_inputs`)
            } catch {
                return ""
            }
        })
        // unsubscribing stops the poll's timer (its only subscriber)
        swayPollUnsub = poll.subscribe(() => {
            try {
                const raw = poll.get()
                if (raw) applyInputs(JSON.parse(raw))
            } catch (e) {
                console.error("keyboard layout:", e)
            }
        })
    }

    // raw IPC input events (lib/swayInput): the i3ipc binding exposes no
    // input event, so the layout name streams over its own connection
    watchSwayInputs({
        onInputs: applyInputs,
        onInputEvent: ev => {
            if (!ev?.input || ev.input.type !== "keyboard") return
            if (!identifier && ev.input.xkb_layout_names?.length) applyKeyboard(ev.input)
            else if (
                ev.input.identifier === identifier &&
                (ev.change === "xkb_layout" || ev.change === "xkb_keymap" || ev.change === "added")
            )
                applyKeyboard(ev.input)
        },
        onUnavailable: startPollFallback,
    })

    return {
        layouts,
        names,
        activeIndex,
        switchTo(i) {
            if (identifier)
                execAsync([msgCmd, "input", identifier, "xkb_switch_layout", String(i)]).catch(e =>
                    console.error("keyboard layout:", e),
                )
        },
    }
}

let source: LayoutSource | null = null
// tracked for dispose(): the hyprland signal handler and the sway
// poll fallback's unsubscribe (the IPC stream is torn down in
// swayInput's unwatchSwayInputs)
let hyprlandObj: AstalHyprland.Hyprland | null = null
let hyprlandLayoutHandler = 0
let swayPollUnsub: (() => void) | null = null

// create the source for the running session, once
export function ensureLayoutSource(): LayoutSource | null {
    if (source) return source
    const ds = Config.desktopSession
    if (ds === "hyprland") source = hyprlandSource()
    else if (ds === "sway" || ds === "i3") source = swaySource(ds === "i3" ? "i3-msg" : "swaymsg")
    return source
}

// convention for lib modules with long-lived sources, even though the
// shell never calls it today: one place that tears everything down
export function dispose() {
    if (lockKb) {
        for (const id of lockHandlerIds) disconnect(lockKb, id)
        lockKb = null
        lockHandlerIds = []
    }
    lockSourceStarted = false
    if (hyprlandObj && hyprlandLayoutHandler) {
        disconnect(hyprlandObj, hyprlandLayoutHandler)
        hyprlandObj = null
        hyprlandLayoutHandler = 0
    }
    swayPollUnsub?.()
    swayPollUnsub = null
    unwatchSwayInputs()
    source = null
}
