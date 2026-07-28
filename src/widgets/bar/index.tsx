import app from "ags/gtk4/app"
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

function trayWidgetFor(gdkMonitor: Gdk.Monitor) {
    if (Config.tray.onPanel) {
        return <Tray />
    } else if (Config.tray.alwaysOnPanel.length > 0) {
        return <Tray filter={isPinned} />
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
        case "osicon": return <OSIcon />
        case "workspaces": return workspaceWidgetFor(gdkMonitor, true)
        case "clock": return <Clock />
        case "stats": return <SysStats />
        case "tray": return trayWidgetFor(gdkMonitor)
        case "quicksettings": return <QSettingsLabel />
        case "language": return <KeyboardLayout />
        case "notifications": return <SwayNC />
        case "media": return <Media monitor={gdkMonitor} />
        default: return null
    }
}

export default function Bar({ gdkMonitor, panel }: {
    gdkMonitor: Gdk.Monitor
    panel?: PanelConfig
}) {
    const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor

    const win = (anchor: number, children: JSX.Element, extraClass = "") => (
        <window
            visible
            name="bar"
            class={hyprsunset.outdoor.as(v =>
                ["Bar", extraClass, v ? "outdoor" : ""]
                    .filter(Boolean).join(" "))}
            namespace="bar"
            gdkmonitor={gdkMonitor}
            exclusivity={Astal.Exclusivity.EXCLUSIVE}
            anchor={anchor}
            application={app}
            heightRequest={30}
        >
            {children}
        </window>
    )

    // config-driven panel: layout comes from the [[panel]] table
    if (panel) {
        return win(
            (panel.position === "bottom" ? BOTTOM : TOP) | LEFT | RIGHT,
            <centerbox cssName="centerbox">
                <box $type="start">
                    {panel.left.map(n => moduleFor(n, gdkMonitor))}
                </box>
                <box $type="center">
                    {panel.center.map(n => moduleFor(n, gdkMonitor))}
                </box>
                <box $type="end">
                    {panel.right.map(n => moduleFor(n, gdkMonitor))}
                </box>
            </centerbox>,
            panel.class
        )
    }

    // legacy layout (no [[panel]] config): the historical arrangement
    let workspaceWidget = workspaceWidgetFor(gdkMonitor)

    // on_panel: the whole tray on the bar. Otherwise only pinned apps
    // (tray.always_on_panel) show on the bar, the rest stay nested.
    let trayWidget = trayWidgetFor(gdkMonitor)

    return win(TOP | LEFT | RIGHT,
        <centerbox cssName="centerbox">
            <box $type="start">
                <OSIcon />
                {Config.workspaces.position == "left" && workspaceWidget}
            </box>
            <box $type="center">
                <Clock />
            </box>
            <box $type="end">
                {Config.quicksettings.statsOnPanel && <SysStats />}
                {Config.media.enabled && <Media monitor={gdkMonitor} />}
                {Config.tray.position == "left" && trayWidget}
                <QSettingsLabel />
                {Config.tray.position == "right" && trayWidget}
                <KeyboardLayout />
                <SwayNC />
                {Config.workspaces.position == "right" && workspaceWidget}
            </box>
        </centerbox>
    )
}
