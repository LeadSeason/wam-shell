import { Astal, Gtk, Gdk } from "ags/gtk4"

import Config, { PanelConfig } from "../../config"
import hyprsunset from "../../lib/hyprsunset"

import OSIcon from "./barModules/osIcon"
import Tray from "../QSettings/tray"
import { isPinned } from "../../lib/trayPinned"
import SwayWs from "./barModules/workspaces-sway"
import HyprlandWs from "./barModules/workspaces-hyprland"
import WorkspacesExample from "./barModules/workspaces-example"
import Clock from "./barModules/clock"
import SwayNC from "./barModules/swayNC"
import KeyboardLayout from "./barModules/keyboardLayout"
import SysStats from "./barModules/sysStats"
import QSettingsLabel from "./barModules/QSettingsLabel"
import Media from "./barModules/media"
import SleepTimer from "./barModules/sleepTimer"
import HarvestTimer from "./barModules/harvest"
import WindowTitle from "./barModules/windowTitle"

// on_panel: the whole tray on the bar. Otherwise only pinned apps
// (tray.always_on_panel) show there, the rest stay in quick settings.
// Monitor-independent, unlike the workspace and media widgets — the
// tray is the same on every bar
function trayWidget() {
    if (Config.tray.onPanel) {
        return <Tray singleRow />
    } else if (Config.tray.alwaysOnPanel.length > 0) {
        return <Tray filter={isPinned} singleRow />
    }
    return null
}

function workspaceWidgetFor(gdkMonitor: Gdk.Monitor, authoritative = false) {
    // panel mode is authoritative: a widget in the list always renders
    if (!authoritative && !Config.workspaces.enabled) return null
    if (Config.desktopSession == "sway" || Config.desktopSession == "i3") {
        return <SwayWs monitor={gdkMonitor} />
    } else if (Config.desktopSession == "hyprland") {
        return <HyprlandWs monitor={gdkMonitor} />
    }
    return <WorkspacesExample />
}

function moduleFor(name: string, gdkMonitor: Gdk.Monitor) {
    // panel lists are authoritative: global toggles (stats_on_panel,
    // workspaces.enabled) do not apply here.
    switch (name) {
        case "osicon":
            return <OSIcon />
        case "workspaces":
            return workspaceWidgetFor(gdkMonitor, true)
        case "clock":
            return <Clock />
        case "stats":
            return <SysStats />
        case "tray":
            return trayWidget()
        case "quicksettings":
            return <QSettingsLabel />
        case "language":
            return <KeyboardLayout />
        case "notifications":
            return <SwayNC />
        case "media":
            return <Media monitor={gdkMonitor} />
        case "sleeptimer":
            return <SleepTimer />
        case "harvest":
            return <HarvestTimer monitor={gdkMonitor} authoritative />
        case "windowtitle":
            return <WindowTitle monitor={gdkMonitor} />
        default:
            return null
    }
}

export default function Bar({
    gdkMonitor,
    panel,
}: {
    gdkMonitor: Gdk.Monitor
    panel?: PanelConfig
}) {
    const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor

    // NO `application={app}` — deliberately, and it is load-bearing (#223).
    //
    // Setting it is what puts the window into the Gtk.Application, and
    // that is the only reason `gtk_window_destroy` emits `window-removed`,
    // which reaches `gtk_application_impl_wayland_window_forget` and
    // segfaults on GTK 4.22's xdg-session-management (SEGV_MAPERR — the
    // toplevel is already freed). Any monitor going away destroys this
    // window through the per-monitor <For> in app.tsx, so an undock took
    // the whole shell down.
    //
    // Reordering the teardown does not help: `set_application(null)`
    // before `destroy()` emits `window-removed` too and crashes one frame
    // earlier. Staying out of the app is the fix.
    //
    // What it costs: `app.get_window()` / `toggle_window()` cannot reach
    // the bars (they all share name="bar" and are never toggled by name),
    // and they no longer appear in `app.windows` — whose one consumer,
    // popupFocus, asks `is_active`, which a layer surface with no keyboard
    // interactivity is never true for. Windows the user actually focuses
    // are still added explicitly in app.tsx.
    // Geometry: per-panel when the [[panel]] table says so, the
    // top-level keys otherwise. `heightRequest` is a floor and not a
    // cap — GTK allocates at least what the content needs, so a panel
    // full of tray icons measures ~38px whatever small number is asked
    // for here. Documented as such in config.toml.
    //
    // A floating panel's margin is drawn by scss on the centerbox, but
    // the WINDOW has to grow by it — otherwise the margin comes out of
    // the strip's own height and `bar_height` stops meaning what it
    // says. Both sides read `bar_float_margin`: scss gets it through
    // active-tuning.scss (see lib/styleCompile.ts).
    const height = panel?.height ?? Config.barHeight
    const floating = panel?.floating ?? Config.barFloating
    const windowHeight = height + (floating ? 2 * Config.barFloatMargin : 0)

    const win = (anchor: number, children: JSX.Element, extraClass = "") => (
        <window
            visible
            name="bar"
            class={hyprsunset.outdoor.as(v =>
                ["Bar", extraClass, floating ? "floating" : "", v ? "outdoor" : ""]
                    .filter(Boolean)
                    .join(" "),
            )}
            namespace="bar"
            gdkmonitor={gdkMonitor}
            exclusivity={Astal.Exclusivity.EXCLUSIVE}
            anchor={anchor}
            heightRequest={windowHeight}
        >
            {children}
        </window>
    )

    // config-driven panel: layout comes from the [[panel]] table
    if (panel) {
        return win(
            (panel.position === "bottom" ? BOTTOM : TOP) | LEFT | RIGHT,
            <centerbox cssName="centerbox">
                <box $type="start">{panel.left.map(n => moduleFor(n, gdkMonitor))}</box>
                <box $type="center">{panel.center.map(n => moduleFor(n, gdkMonitor))}</box>
                <box $type="end">{panel.right.map(n => moduleFor(n, gdkMonitor))}</box>
            </centerbox>,
            panel.class,
        )
    }

    // legacy layout (no [[panel]] config): the historical arrangement
    const workspaces = workspaceWidgetFor(gdkMonitor)
    const tray = trayWidget()

    return win(
        TOP | LEFT | RIGHT,
        <centerbox cssName="centerbox">
            <box $type="start">
                <OSIcon />
                {Config.workspaces.position == "left" && workspaces}
            </box>
            <box $type="center">
                <Clock />
                {Config.harvest.enabled && <HarvestTimer monitor={gdkMonitor} />}
            </box>
            <box $type="end">
                <SleepTimer />
                {Config.quicksettings.statsOnPanel && <SysStats />}
                {Config.media.enabled && <Media monitor={gdkMonitor} />}
                {Config.tray.position == "left" && tray}
                <QSettingsLabel />
                {Config.tray.position == "right" && tray}
                <KeyboardLayout />
                <SwayNC />
                {Config.workspaces.position == "right" && workspaces}
            </box>
        </centerbox>,
    )
}
