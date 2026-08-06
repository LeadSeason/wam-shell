import Gtk from "gi://Gtk?version=4.0"
import { Accessor, onCleanup } from "gnim"

/**
 * A volume percentage you can type into: click the number, enter a
 * value, press Enter.
 *
 * The sliders are damped for aiming by hand, which is right for nudging
 * and wrong for "make it exactly 40" — this is the way to say the exact
 * number. Built on GtkEditableLabel so it reads as text until it is
 * clicked, rather than sitting in the row as a permanent input box.
 *
 * @param value the volume, 0..max, where 1 is 100%
 * @param onCommit called with the parsed value, already clamped
 * @param max the ceiling typing can reach, matching the slider's own
 */
export function PercentEntry({
    value,
    onCommit,
    max = 1.5,
    extraClasses = [],
}: {
    value: Accessor<number>
    onCommit: (v: number) => void
    max?: number
    extraClasses?: string[]
}) {
    const text = value.as(v => `${Math.round(v * 100)}%`)
    let field: Gtk.EditableLabel | null = null

    // the number follows the volume except while it is being typed
    // into: rewriting the text under the cursor would fight the user
    // mid-edit (and moves the caret)
    const unsub = text.subscribe(() => {
        if (field && !field.editing) field.text = text.get()
    })
    onCleanup(() => unsub())

    function commit(self: Gtk.EditableLabel) {
        // "40", "40%", " 40 % " all mean the same thing
        const typed = Number.parseFloat(self.text.replace("%", "").trim())
        if (Number.isFinite(typed)) onCommit(Math.min(max, Math.max(0, typed / 100)))
        // either way the label goes back to rendering the real volume:
        // a rejected "abc" must not linger looking like it was accepted,
        // and a clamped 900 must show what it actually became
        self.text = text.get()
    }

    return (
        <Gtk.EditableLabel
            cssClasses={["percentEntry", ...extraClasses]}
            widthChars={5}
            maxWidthChars={5}
            xalign={1}
            tooltipText={"Click to type a value"}
            $={self => {
                field = self
                self.text = text.get()
                // editing ends on Enter, on Escape, and on focus loss.
                // Escape restores the old text before this fires, so
                // parsing it back is a no-op rather than a special case
                self.connect("notify::editing", () => {
                    if (!self.editing) {
                        commit(self)
                        return
                    }
                    // a bare number to type over: the % is decoration
                    // that would otherwise have to be deleted first, and
                    // it comes back on its own once the value is set
                    self.text = String(Math.round(value.get() * 100))
                    // and select it, so typing replaces rather than
                    // appending to whatever was already there
                    self.select_region(0, -1)
                })
            }}
        >
            {/* one click, not two: the default double-click to edit is
            not discoverable on a number that looks like a label */}
            <Gtk.GestureClick button={1} onPressed={() => field?.start_editing()} />
        </Gtk.EditableLabel>
    )
}
