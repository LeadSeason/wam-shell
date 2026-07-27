import { Accessor, createState } from "gnim"
import { Gtk } from "ags/gtk4"
import { exec, execAsync } from "ags/process"
import { createPoll } from "ags/time"
import { readFile } from "ags/file"
import AstalHyprland from "gi://AstalHyprland"
import Config from "../../../config"

// Keyboard layout indicator. Bar shows the active layout's flag, clicking
// opens a dropdown of all configured layouts with flag and name; picking
// one switches to it directly. Backends: hyprland (events) and sway/i3
// (polled swaymsg/i3-msg).

// xkb codes that are not ISO country codes
const FLAG_OVERRIDES: Record<string, string> = {
    ara: "🇮🇶", // Arabic
    latam: "🌎", // Latin American, no single country
    epo: "🟩",   // Esperanto, green like its flag
}

function flag(code: string): string {
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

interface LayoutSource {
    layouts: Accessor<string[]> // xkb codes ("" when unknown)
    names: Accessor<string[]>   // display name per index
    activeIndex: Accessor<number>
    switchTo(i: number): void
}

function hyprlandSource(): LayoutSource {
    const hyprland = AstalHyprland.get_default()
    const xkbNames = loadXkbNames()
    const [layouts, setLayouts] = createState<string[]>([])
    const [variants, setVariants] = createState<string[]>([])
    const [activeIndex, setActiveIndex] = createState(0)
    let mainKb = ""

    function refresh() {
        try {
            const devices = JSON.parse(exec("hyprctl devices -j"))
            const kb = devices.keyboards.find((k: any) => k.main)
                ?? devices.keyboards[0]
            if (!kb) return
            mainKb = kb.name
            setLayouts(kb.layout.split(",").map((s: string) => s.trim()))
            setVariants((kb.variant ?? "").split(",")
                .map((s: string) => s.trim()))
            setActiveIndex(kb.active_layout_index)
        } catch (e) {
            console.error("keyboard layout:", e)
        }
    }

    refresh()
    hyprland.connect("keyboard-layout", refresh)

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

    const poll = createPoll("", 1000, `${msgCmd} -t get_inputs`)
    poll.subscribe(() => {
        try {
            const inputs = JSON.parse(poll.get())
            const kb = inputs.find((k: any) =>
                k.type === "keyboard" && k.xkb_layout_names?.length > 0)
            if (!kb) return
            identifier = kb.identifier
            const ns = kb.xkb_layout_names as string[]
            setNames(ns)
            setLayouts(ns.map(n => descToCode[n] ?? ""))
            setActiveIndex(kb.xkb_active_layout_index ?? 0)
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

function LayoutDropdown({ source }: { source: LayoutSource }) {
    const { layouts, names, activeIndex } = source
    let pop: Gtk.Popover | null = null

    return <menubutton
        cssClasses={["keyboardLayout"]}
        tooltipText={activeIndex.as(i =>
            names.get()[i] ?? "Keyboard layout")}>
        <label label={activeIndex.as(i => {
            const code = layouts.get()[i] ?? ""
            return flag(code) || code.toUpperCase() || "⌨"
        })} />
        <popover
            hasArrow={false}
            $={(self) => { pop = self as Gtk.Popover }}
        >
            <box orientation={Gtk.Orientation.VERTICAL}>
                {names.get().map((n, i) =>
                    <button
                        cssClasses={activeIndex.as(a => a === i ? ["active"] : [])}
                        onClicked={() => {
                            source.switchTo(i)
                            pop?.popdown()
                        }}
                    >
                        <box spacing={8}>
                            <label label={flag(layouts.get()[i] ?? "") || "  "} />
                            <label label={n} xalign={0} />
                        </box>
                    </button>
                )}
            </box>
        </popover>
    </menubutton>
}

export default function KeyboardLayout() {
    const ds = Config.desktopSession
    if (ds === "hyprland")
        return <LayoutDropdown source={hyprlandSource()} />
    if (ds === "sway" || ds === "i3")
        return <LayoutDropdown source={swaySource(ds === "i3" ? "i3-msg" : "swaymsg")} />
    return <></>
}
