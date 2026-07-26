import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { createPoll } from "ags/time"

import Config from "../../config"

import OSIcon from "./barModules/osIcon"
import SwayWs from "./barModules/workspaces-sway"
import HyprlandWs from "./barModules/workspaces-hyprland"
import WorkspacesExample from "./barModules/workspaces-example"
import Clock from "./barModules/clock"
import SwayNC from "./barModules/swayNC"
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

  return (
    <window
      visible
      name="bar"
      class="Bar"
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
          <QSettingsLabel />
          <SwayNC />
          {Config.workspaces.position == "right" && workspaceWidget}
        </box>
      </centerbox>
    </window>
  )
}
