import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { createPoll } from "ags/time"

import Config from "../../config"
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
import QSettingsLabel from "./barModules/QSettingsLabel"


export default function Bar({ gdkMonitor: gdkMonitor }: { gdkMonitor: Gdk.Monitor }) {
  const time = createPoll("", 1000, "date")
  const { TOP, LEFT, RIGHT } = Astal.WindowAnchor

  let workspaceWidget = null
  if (Config.workspaces.enabled) {
    if (Config.desktopSession == "sway" || Config.desktopSession == "i3") {
      workspaceWidget = <SwayWs monitor={gdkMonitor} />
    } else if (Config.desktopSession == "hyprland") {
      workspaceWidget = <HyprlandWs monitor={gdkMonitor} />
    } else {
      workspaceWidget = <WorkspacesExample />
    }
  }

  // on_panel: the whole tray on the bar. Otherwise only pinned apps
  // (tray.always_on_panel) show on the bar, the rest stay nested.
  // Tray items must be single-instance: the bar is built per monitor,
  // so only render it on the primary one.
  let trayWidget = null
  if (app.monitors[0] === gdkMonitor) {
    if (Config.tray.onPanel) {
      trayWidget = <Tray />
    } else if (Config.tray.alwaysOnPanel.length > 0) {
      trayWidget = <Tray filter={isPinned} />
    }
  }

  return (
    <window
      visible
      name="bar"
      class={hyprsunset.outdoor.as(v => v ? "Bar outdoor" : "Bar")}
      namespace="bar"
      gdkmonitor={gdkMonitor}
      exclusivity={Astal.Exclusivity.EXCLUSIVE}
      anchor={TOP | LEFT | RIGHT}
      application={app}
      heightRequest={30}
    >
      <centerbox cssName="centerbox">
        <box $type="start">
          <OSIcon />
          {Config.workspaces.position == "left" && workspaceWidget}
        </box>
        <box $type="center">
          <Clock />
        </box>
        <box $type="end">
          {Config.tray.position == "left" && trayWidget}
          <QSettingsLabel />
          {Config.tray.position == "right" && trayWidget}
          {Config.desktopSession == "hyprland" && <KeyboardLayout />}
          <SwayNC />
          {Config.workspaces.position == "right" && workspaceWidget}
        </box>
      </centerbox>
    </window>
  )
}
