import AstalHyprland from "gi://AstalHyprland"
import { hyprlandIpcUp } from "./hyprlandIpc"

// The one door to AstalHyprland. Every get_default() call site goes
// through here.
//
// get_default() connects to the compositor socket and reads from the
// connection WITHOUT checking that the connect succeeded — with the
// socket absent it dereferences a null stream and the process dies
// inside the library, where try/catch cannot reach (#225). So a stat
// gates the construction: no sockets, no AstalHyprland, and the caller
// renders its degraded state instead.
//
// After the first successful construction the library caches the
// singleton, so later calls with a dead socket hand back the live
// instance instead of constructing into a segfault; before it, the
// probe re-runs on every call (two stats), which is what lets a
// compositor that appears or restarts mid-session be picked up by the
// next consumer — a bar rebuilt on monitor hotplug, a popup opened
// later, the layout source re-ensured by the OSD.

let cached: AstalHyprland.Hyprland | null = null

export function getHyprland(): AstalHyprland.Hyprland | null {
    if (cached !== null) return cached
    if (!hyprlandIpcUp()) return null
    cached = AstalHyprland.get_default()
    return cached
}
