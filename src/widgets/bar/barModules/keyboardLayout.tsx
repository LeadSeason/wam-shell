import { createState } from "gnim"
import { Gtk } from "ags/gtk4"
import { exec, execAsync } from "ags/process"
import { readFile } from "ags/file"
import AstalHyprland from "gi://AstalHyprland"

// Keyboard layout indicator (hyprland only). Bar shows the active layout's
// flag, clicking opens a dropdown of all configured layouts with flag and
// name; picking one switches to it directly.

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

export default function KeyboardLayout() {
    const hyprland = AstalHyprland.get_default()
    const xkbNames = loadXkbNames()
    const [layouts, setLayouts] = createState<string[]>([])
    const [variants, setVariants] = createState<string[]>([])
    const [activeIndex, setActiveIndex] = createState(0)
    let mainKb = ""
    let pop: Gtk.Popover | null = null

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

    const name = (code: string) => xkbNames[code] ?? code.toUpperCase()
    const label = (i: number, code: string) => {
        const v = variants.get()[i]
        return v ? `${name(code)} (${v})` : name(code)
    }

    return <menubutton
        cssClasses={["keyboardLayout"]}
        tooltipText={activeIndex.as(i => {
            const code = layouts.get()[i]
            return code ? label(i, code) : "Keyboard layout"
        })}>
        <label label={activeIndex.as(i => {
            const code = layouts.get()[i] ?? ""
            return flag(code) || code.toUpperCase()
        })} />
        <popover
            hasArrow={false}
            $={(self) => { pop = self as Gtk.Popover }}
        >
            <box orientation={Gtk.Orientation.VERTICAL}>
                {layouts.get().map((code, i) =>
                    <button
                        cssClasses={activeIndex.as(a => a === i ? ["active"] : [])}
                        onClicked={() => {
                            if (mainKb)
                                execAsync(["hyprctl", "switchxkblayout",
                                    mainKb, String(i)])
                                    .catch(e => console.error("keyboard layout:", e))
                            pop?.popdown()
                        }}
                    >
                        <box spacing={8}>
                            <label label={flag(code) || "  "} />
                            <label label={label(i, code)} xalign={0} />
                        </box>
                    </button>
                )}
            </box>
        </popover>
    </menubutton>
}
