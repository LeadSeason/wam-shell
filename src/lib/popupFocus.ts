import app from "ags/gtk4/app"
import GLib from "gi://GLib?version=2.0"
import { connect, timeoutAdd } from "./metrics"
import type { Gtk } from "ags/gtk4"

// Close a popup when keyboard focus leaves the shell entirely. The
// popup windows used to be keymode EXCLUSIVE, which grabbed the whole
// seat and stole input from other surfaces (third-party notification
// popups). Focus moving between OUR windows is not leaving: settle
// briefly (the other window's activation lands a tick later), then
// close only when no shell window holds focus anymore.
export function hideOnFocusLoss(win: Gtk.Window, hide: () => void) {
    connect(win, "notify::is-active", (_w: Gtk.Window) => {
        if (win.is_active) return
        timeoutAdd("popupFocus:loss", GLib.PRIORITY_DEFAULT, 150, () => {
            if (!app.windows.some(w => w.is_active)) hide()
            return GLib.SOURCE_REMOVE
        })
    })
}
