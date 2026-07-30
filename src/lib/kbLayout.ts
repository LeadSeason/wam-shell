import { Accessor, createState } from "gnim"
import GLib from "gi://GLib?version=2.0"
import { execAsync, connect, timeoutAdd } from "./metrics"
import { createPoll } from "ags/time"
import { readFile } from "ags/file"
import AstalHyprland from "gi://AstalHyprland"
import Config from "../config"

// Shared keyboard layout source. The bar dropdown and the OSD both
// consume it; it runs when either exists, independent of panel config.

// xkb codes that are not ISO country codes
const FLAG_OVERRIDES: Record<string, string> = {
    ara: "🇮🇶", // Arabic
    latam: "🌎", // Latin American, no single country
    epo: "🟩",   // Esperanto, green like its flag
}

export function flag(code: string): string {
    if (code in FLAG_OVERRIDES) return FLAG_OVERRIDES[code]
    if (/^[a-z]{2}$/.test(code))
        return String.fromCodePoint(
            ...[...code].map(c => 0x1F1E6 + c.charCodeAt(0) - 97))
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

export interface LayoutSource {
    layouts: Accessor<string[]> // xkb codes ("" when unknown)
    names: Accessor<string[]>   // display name per index
    activeIndex: Accessor<number>
    switchTo(i: number): void
}

// fed by the backends on layout change; the OSD shows it
export const [layoutOsdText, setLayoutOsdText] = createState("")

// caps/num lock state, parsed from the same hyprctl device read the
// layout source already does. Shared so the lock-keys OSD does not need
// its own recurring hyprctl poll. null before the first read.
export const [lockKeyState, setLockKeyState] =
    createState<{ caps: boolean, num: boolean } | null>(null)

function hyprlandSource(): LayoutSource {
    const hyprland = AstalHyprland.get_default()
    const xkbNames = loadXkbNames()
    const [layouts, setLayouts] = createState<string[]>([])
    const [variants, setVariants] = createState<string[]>([])
    const [activeIndex, setActiveIndex] = createState(0)
    let mainKb = ""

    function refresh() {
        execAsync("hyprctl devices -j").then((out) => {
            const devices = JSON.parse(out)
            const kb = devices.keyboards.find((k: any) => k.main)
                ?? devices.keyboards[0]
            if (!kb) return
            mainKb = kb.name
            const codes = kb.layout.split(",").map((s: string) => s.trim())
            setLayouts(codes)
            setVariants((kb.variant ?? "").split(",")
                .map((s: string) => s.trim()))
            setActiveIndex(kb.active_layout_index)
            // caps/num lock for the lock-keys OSD: published from this
            // same device read so the OSD needs no poll of its own
            setLockKeyState({ caps: !!kb.capsLock, num: !!kb.numLock })
            if (kb.active_layout_index === lastIndex) return
            const wasFirst = lastIndex === null
            lastIndex = kb.active_layout_index
            if (wasFirst) return
            const code = codes[kb.active_layout_index] ?? ""
            const base = xkbNames[code] ?? code.toUpperCase()
            setLayoutOsdText(`${flag(code)} ${base}`.trim())
        }).catch((e) => console.error("keyboard layout:", e))
    }

    let lastIndex: number | null = null
    refresh()
    // signal for instant updates, poll as fallback. 1s also drives caps/num
    // lock detection (no separate lock-keys poll elsewhere).
    connect(hyprland, "keyboard-layout", refresh)
    timeoutAdd("kbLayout:poll", GLib.PRIORITY_DEFAULT, 1000, () => {
        refresh()
        return GLib.SOURCE_CONTINUE
    })

    return {
        layouts,
        names: layouts.as(ls => ls.map((code, i) => {
            const base = xkbNames[code] ?? code.toUpperCase()
            const v = variants.get()[i]
            return v ? `${base} (${v})` : base
        })),
        activeIndex,
        switchTo(i) {
            if (mainKb)
                execAsync(["hyprctl", "switchxkblayout", mainKb, String(i)])
                    .catch(e => console.error("keyboard layout:", e))
        },
    }
}

function swaySource(msgCmd: string): LayoutSource {
    // sway gives layout descriptions, not codes; reverse the xkb db
    const xkbNames = loadXkbNames()
    const descToCode: Record<string, string> = {}
    for (const [code, desc] of Object.entries(xkbNames))
        if (!(desc in descToCode)) descToCode[desc] = code

    const [layouts, setLayouts] = createState<string[]>([])
    const [names, setNames] = createState<string[]>([])
    const [activeIndex, setActiveIndex] = createState(0)
    let identifier = ""

    // 3s: a layout indicator doesn't need sub-second latency, and this
    // spawns swaymsg/i3msg for the shell's lifetime otherwise
    const poll = createPoll("", 3000, async () => {
        // swallow failures (binary missing, IPC down): keep old value
        try {
            return await execAsync(`${msgCmd} -t get_inputs`)
        } catch {
            return ""
        }
    })
    let prevIndex: number | null = null
    poll.subscribe(() => {
        try {
            const raw = poll.get()
            if (!raw) return
            const inputs = JSON.parse(raw)
            const kb = inputs.find((k: any) =>
                k.type === "keyboard" && k.xkb_layout_names?.length > 0)
            if (!kb) return
            identifier = kb.identifier
            const ns = kb.xkb_layout_names as string[]
            setNames(ns)
            setLayouts(ns.map(n => descToCode[n] ?? ""))
            const idx = kb.xkb_active_layout_index ?? 0
            setActiveIndex(idx)
            if (prevIndex !== null && idx !== prevIndex) {
                const code = descToCode[ns[idx]] ?? ""
                setLayoutOsdText(`${flag(code)} ${ns[idx]}`.trim())
            }
            prevIndex = idx
        } catch (e) {
            console.error("keyboard layout:", e)
        }
    })

    return {
        layouts,
        names,
        activeIndex,
        switchTo(i) {
            if (identifier)
                execAsync([msgCmd, "input", identifier,
                    "xkb_switch_layout", String(i)])
                    .catch(e => console.error("keyboard layout:", e))
        },
    }
}

let source: LayoutSource | null = null

// create the source for the running session, once
export function ensureLayoutSource(): LayoutSource | null {
    if (source) return source
    const ds = Config.desktopSession
    if (ds === "hyprland") source = hyprlandSource()
    else if (ds === "sway" || ds === "i3")
        source = swaySource(ds === "i3" ? "i3-msg" : "swaymsg")
    return source
}
