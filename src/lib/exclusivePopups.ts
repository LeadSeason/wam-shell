// Bar popups that should not be open at the same time.
//
// The quick settings and the notification center are both full-height
// panels anchored to the same corner, and opening one on top of the
// other left two overlapping cards with the lower one unreachable —
// they are alternatives, not layers.
//
// Registration rather than direct calls between the two: each panel is
// built lazily, in its own module, and neither should have to import
// the other (or know how many others there are) to behave. Adding a
// third is one registerPopup call plus one closeOthers call.

type Closer = () => void

const closers = new Map<string, Closer>()

/**
 * Declare a popup that takes over the screen corner.
 *
 * @param name unique key; re-registering under the same name replaces
 *        the closer, so a rebuilt window cannot leave a stale one behind
 * @param close must be safe to call when the popup is ALREADY closed —
 *        it is invoked on every other popup opening, not just when this
 *        one happens to be up
 */
export function registerPopup(name: string, close: Closer) {
    closers.set(name, close)
}

/** Close every registered popup except the one opening. */
export function closeOtherPopups(except: string) {
    for (const [name, close] of closers) {
        if (name === except) continue
        try {
            close()
        } catch (e) {
            // one panel failing to close must not stop the others, and
            // must not abort the open that triggered this
            console.warn(`exclusivePopups: ${name} failed to close:`, e)
        }
    }
}
