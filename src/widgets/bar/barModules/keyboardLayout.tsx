import { Gtk } from "ags/gtk4"
import { createComputed, For } from "gnim"
import { ensureLayoutSource, flag, LayoutSource } from "../../../lib/kbLayout"
import { createScrollStepper } from "../../../lib/scrollStep"

// Keyboard layout indicator. Bar shows the active layout's flag, clicking
// opens a dropdown of all configured layouts with flag and name; picking
// one switches to it directly. The source lives in lib/kbLayout and is
// shared with the OSD.

function LayoutDropdown({ source }: { source: LayoutSource }) {
    const { layouts, names, activeIndex } = source
    let pop: Gtk.Popover | null = null

    // computed over both: layouts arrive async after startup, a binding
    // on activeIndex alone stays empty until the first switch
    const labelText = createComputed(() => {
        const i = activeIndex()
        const ls = layouts()
        const code = ls[i] ?? ""
        return flag(code) || code.toUpperCase() || "⌨"
    })

    // scroll cycles layouts without opening the dropdown. WRAPPING here,
    // unlike the workspace steppers: the layout list is short and fixed,
    // and cycling between two is the entire point — stopping at the end
    // of a two-item list would make one direction dead half the time.
    const step = createScrollStepper()
    const cycle = (dir: -1 | 0 | 1) => {
        if (dir === 0) return
        const count = layouts.peek().length
        if (count < 2) return
        source.switchTo((activeIndex.peek() + dir + count) % count)
    }

    return (
        <menubutton
            cssClasses={["keyboardLayout"]}
            tooltipText={createComputed(() => {
                const i = activeIndex()
                const ns = names()
                return ns[i] ?? "Keyboard layout"
            })}
        >
            <Gtk.EventControllerScroll
                flags={Gtk.EventControllerScrollFlags.VERTICAL}
                onScroll={(controller, _dx, dy) => {
                    cycle(step(controller, dy))
                    return true
                }}
            />
            <label label={labelText} />
            <popover
                hasArrow={false}
                $={self => {
                    pop = self as Gtk.Popover
                }}
            >
                <box orientation={Gtk.Orientation.VERTICAL}>
                    {/* names arrive async after startup; a static snapshot
                    stays empty for the shell's lifetime. Iterate indices
                    (unique, so gnim's value-keying can't drop rows):
                    duplicate layout descriptions — e.g. us,us with
                    different variants — would otherwise lose a row */}
                    <For each={names.as(ns => ns.map((_, i) => i))}>
                        {(k, i) => (
                            <button
                                cssClasses={createComputed(() => {
                                    const a = activeIndex()
                                    const idx = i()
                                    return a === idx ? ["active"] : []
                                })}
                                onClicked={() => {
                                    source.switchTo(i.peek())
                                    pop?.popdown()
                                }}
                            >
                                <box spacing={8}>
                                    <label
                                        label={createComputed(() => {
                                            const ls = layouts()
                                            const idx = i()
                                            return flag(ls[idx] ?? "") || "  "
                                        })}
                                    />
                                    <label
                                        label={createComputed(() => {
                                            const ns = names()
                                            const idx = i()
                                            return ns[idx] ?? ""
                                        })}
                                        xalign={0}
                                    />
                                </box>
                            </button>
                        )}
                    </For>
                </box>
            </popover>
        </menubutton>
    )
}

export default function KeyboardLayout() {
    const source = ensureLayoutSource()
    if (!source) return <></>
    return <LayoutDropdown source={source} />
}
