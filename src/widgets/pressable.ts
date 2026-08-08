import { Gtk } from "ags/gtk4"

/**
 * Signal props for a `Gtk.GestureClick` that also PAINTS the press.
 *
 * GTK sets `:active` on real buttons and nothing else. Everything the
 * shell builds out of a box plus a gesture — the quick settings tiles,
 * the chevron that opens a pane, the slider row's buttons — therefore
 * answered a click with no state change at all: every `:active` rule
 * written for them was dead CSS, and the first thing that moved on
 * screen was whatever the click had started (a pane sliding in). Nothing
 * was slow; the click just went unacknowledged for the length of the
 * animation, which is what reads as lag.
 *
 * The flag goes on the gesture's OWN widget, which is what makes a
 * two-part tile work: GTK propagates the state both up the ancestor
 * chain and down into children (measured — a flag set on the chevron
 * comes back set on the tile and on the tile's parent). So flagging the
 * inner body box lights the whole tile and leaves the chevron beside it
 * alone, while flagging the chevron lights the tile AND the chevron.
 * One press each, told apart by where the extra fill is.
 *
 * Spread into the gesture in place of `onPressed`:
 *
 *     <Gtk.GestureClick button={1} {...pressable(navigate)} />
 */
export function pressable(onPress: () => void) {
    const paint = (gesture: Gtk.Gesture, down: boolean) => {
        const widget = gesture.get_widget()
        if (!widget) return
        if (down) widget.set_state_flags(Gtk.StateFlags.ACTIVE, false)
        else widget.unset_state_flags(Gtk.StateFlags.ACTIVE)
    }
    return {
        onPressed: (gesture: Gtk.Gesture) => {
            paint(gesture, true)
            onPress()
        },
        // released is the ordinary click; cancel a grab lost to
        // something else, end a press that was dragged off the widget
        // — miss one and the tile stays lit until the next press
        onReleased: (gesture: Gtk.Gesture) => paint(gesture, false),
        onCancel: (gesture: Gtk.Gesture) => paint(gesture, false),
        onEnd: (gesture: Gtk.Gesture) => paint(gesture, false),
    }
}
