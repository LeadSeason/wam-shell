import app from "ags/gtk4/app"
import GLib from "gi://GLib?version=2.0"
import AstalHyprland from "gi://AstalHyprland"
import { connect, disconnect, timeoutAdd, sourceRemove } from "./metrics"
import Config from "../config"
import type { Gtk } from "ags/gtk4"
import { registerDispose } from "./lifecycle"

// Close a popup when keyboard focus leaves the shell entirely. The
// popup windows used to be keymode EXCLUSIVE, which grabbed the whole
// seat and stole input from other surfaces (third-party notification
// popups). ON_DEMAND only grabs on click, so a toggle-opened window
// may never become active at all — only start watching after the
// window actually held focus once, or it would close instantly after
// every programmatic open. Focus moving between OUR windows is not
// leaving: settle briefly (the other window's activation lands a tick
// later), then close only when no shell window holds focus anymore.
// Windows that lost focus while another shell window was active stay
// pending: when focus finally leaves every window, all pending popups
// hide — a stacked popup can no longer be stranded on screen forever.
//
// Exception: screenshot region pickers (slurp & co.) deliberately take
// keyboard focus, and the capture (grim) happens right after the picker
// exits. Hiding then would make the popups uncapturable, so focus loss
// is ignored while a picker layer surface is open, plus a grace tail.
//
// Perf harness (tests/perf/run.sh sets WAM_SHELL_NO_FOCUS_WATCH=1):
// the watcher is disabled — the measured instance shares the live
// session, and its focus bounces would churn hide timers in the
// metrics (#25)

// windows that held focus and lost it, waiting for the shell to lose
// focus entirely
const pending = new Set<Gtk.Window>()
const hideByWindow = new Map<Gtk.Window, () => void>()
let checkTimer = 0

function checkFocus() {
    if (checkTimer) return
    checkTimer = timeoutAdd("popupFocus:loss", GLib.PRIORITY_DEFAULT, 150, () => {
        checkTimer = 0
        // picker active: keep re-checking instead of hiding; once it
        // closes and the grace lapses, the normal logic applies
        if (screenshotInProgress()) {
            checkFocus()
            return GLib.SOURCE_REMOVE
        }
        if (!app.windows.some(w => w.is_active)) {
            for (const win of pending) {
                pending.delete(win)
                const hide = hideByWindow.get(win)
                hideByWindow.delete(win)
                hide?.()
            }
        }
        return GLib.SOURCE_REMOVE
    })
}

export function hideOnFocusLoss(win: Gtk.Window, hide: () => void) {
    // GLib.getenv at call time: the function runs per popup at window
    // construction, always after the process env is fixed
    if (GLib.getenv("WAM_SHELL_NO_FOCUS_WATCH") === "1") return
    let wasActive = false
    connect(win, "notify::is-active", (_w: Gtk.Window) => {
        if (win.is_active) {
            wasActive = true
            // subscribe to picker events only once a popup first holds
            // focus: the listener must exist before any focus loss, and
            // a loss requires a prior gain. Hooking here keeps it out of
            // startup (the notification center registers at boot) and
            // off entirely for users who never click into a popup
            hookHyprland()
            return
        }
        if (!wasActive) return
        pending.add(win)
        hideByWindow.set(win, hide)
        checkFocus()
    })
}

// layer-surface namespaces of known screenshot pickers: "selection" is
// slurp (hyprshot/grimblast wrap it), the rest are alternative tools.
// Hyprland announces them via openlayer/closelayer on its IPC.
const PICKER_NAMESPACES = new Set(["selection", "hyprpicker", "wayshot", "screenshot"])
// grim captures the moment slurp exits — the suppression must outlive
// the picker by a beat or the popups hide mid-capture
const GRACE_MS = 1500

let hyprHooked = false
let hyprHandler = 0
let pickerLayers = 0
let graceUntil = 0

function screenshotInProgress(): boolean {
    return pickerLayers > 0 || Date.now() < graceUntil
}

// lazy and session-gated: get_default() touches the compositor socket,
// which must stay out of import (tests import lib modules; i3 sessions
// have no hyprland socket)
function hookHyprland() {
    if (hyprHooked) return
    hyprHooked = true
    if (Config.desktopSession !== "hyprland") return
    const hyprland = AstalHyprland.get_default()
    hyprHandler = connect(hyprland, "event", (_h, name: string, data: string) => {
        if (!PICKER_NAMESPACES.has(data)) return
        if (name === "openlayer") {
            pickerLayers++
        } else if (name === "closelayer" && pickerLayers > 0) {
            // one surface per monitor: only the last close starts grace
            pickerLayers--
            if (pickerLayers === 0) graceUntil = Date.now() + GRACE_MS
        }
    })
}

// convention for lib modules with long-lived sources, even though the
// shell never calls it today: one place that tears everything down.
// Per-window handlers are not tracked here — they die with their window
export function dispose() {
    if (hyprHandler) {
        disconnect(AstalHyprland.get_default(), hyprHandler)
        hyprHandler = 0
    }
    if (checkTimer) {
        sourceRemove(checkTimer)
        checkTimer = 0
    }
    pending.clear()
    hideByWindow.clear()
    hyprHooked = false
    pickerLayers = 0
    graceUntil = 0
}

// tear-down entry point, run from app.tsx on shutdown (lib/lifecycle)
registerDispose("popupFocus", dispose)
