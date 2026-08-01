import app from "ags/gtk4/app"
import GLib from "gi://GLib?version=2.0"
import AstalHyprland from "gi://AstalHyprland"
import { connect, disconnect, timeoutAdd } from "./metrics"
import Config from "../config"
import type { Gtk } from "ags/gtk4"

// Close a popup when keyboard focus leaves the shell entirely. The
// popup windows used to be keymode EXCLUSIVE, which grabbed the whole
// seat and stole input from other surfaces (third-party notification
// popups). ON_DEMAND only grabs on click, so a toggle-opened window
// may never become active at all — only start watching after the
// window actually held focus once, or it would close instantly after
// every programmatic open. Focus moving between OUR windows is not
// leaving: settle briefly (the other window's activation lands a tick
// later), then close only when no shell window holds focus anymore.
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
export function hideOnFocusLoss(win: Gtk.Window, hide: () => void) {
    // GLib.getenv at call time: the function runs per popup at window
    // construction, always after the process env is fixed
    if (GLib.getenv("WAM_SHELL_NO_FOCUS_WATCH") === "1") return
    let wasActive = false
    // one settle timer at a time per window: a focus storm (the perf
    // harness shares the live session) must not stack one per bounce
    let lossTimer = 0
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
        if (!wasActive || lossTimer) return
        lossTimer = timeoutAdd("popupFocus:loss", GLib.PRIORITY_DEFAULT, 150, () => {
            // picker active: keep re-checking instead of hiding; once it
            // closes and the grace lapses, the normal logic applies
            if (screenshotInProgress()) return GLib.SOURCE_CONTINUE
            lossTimer = 0
            if (!app.windows.some(w => w.is_active)) {
                wasActive = false
                hide()
            }
            return GLib.SOURCE_REMOVE
        })
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
    hyprHooked = false
    pickerLayers = 0
    graceUntil = 0
}
