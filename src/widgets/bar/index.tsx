import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { createPoll } from "ags/time"

import Config from "../../config"

import OSIcon from "./barModules/osIcon"
import SwayWs from "./barModules/workspaces-sway"
import WorkspacesExample from "./barModules/workspaces-example"
import { AudioInput, AudioOutput } from "./barModules/audio"
import Clock from "./barModules/clock"


export default function Bar({ gdkMonitor: gdkMonitor }: { gdkMonitor: Gdk.Monitor }) {
  const time = createPoll("", 1000, "date")
  const { TOP, LEFT, RIGHT } = Astal.WindowAnchor

  let workspaceWidget
  if (Config.desktopSession == "sway") {
    workspaceWidget = <SwayWs monitor={gdkMonitor} />
  } else {
    workspaceWidget = <WorkspacesExample />
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
          {workspaceWidget}
        </box>
        <box $type="center">
          <Clock />
        </box>
        <box $type="end">
          <AudioInput />
          <AudioOutput />
        </box>
      </centerbox>
    </window>
  )
}
