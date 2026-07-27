import { Gtk } from "ags/gtk4"
import { createComputed } from "gnim"
import {
    ensureLayoutSource, flag, LayoutSource,
} from "../../../lib/kbLayout"

// Keyboard layout indicator. Bar shows the active layout's flag, clicking
// opens a dropdown of all configured layouts with flag and name; picking
// one switches to it directly. The source lives in lib/kbLayout and is
// shared with the OSD.

function LayoutDropdown({ source }: { source: LayoutSource }) {
    const { layouts, names, activeIndex } = source
    let pop: Gtk.Popover | null = null

    // computed over both: layouts arrive async after startup, a binding
    // on activeIndex alone stays empty until the first switch
    const labelText = createComputed([activeIndex, layouts], (i, ls) => {
        const code = ls[i] ?? ""
        return flag(code) || code.toUpperCase() || "⌨"
    })

    return <menubutton
        cssClasses={["keyboardLayout"]}
        tooltipText={createComputed([activeIndex, names],
            (i, ns) => ns[i] ?? "Keyboard layout")}>
        <label label={labelText} />
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
    const source = ensureLayoutSource()
    if (!source) return <></>
    return <LayoutDropdown source={source} />
}
