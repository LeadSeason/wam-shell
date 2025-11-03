import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { createPoll } from "ags/time"

import Config from "../../config"
import SwayWs from "./widgets/sway"

function OSIcon() {
  const icon = Config.osIcon
  let iconImage

  if (icon.includes("/"))
    iconImage = <image file={icon} pixelSize={24} />
  else
    iconImage = <image iconName={icon} pixelSize={24} />

  return <button>
    {iconImage}
  </button>
}

function WorkspacesExample() {
  return <box cssName={"workspaces"}>
    <button cssName={"workspace"}>
      <box>
        <label label="1" />
        <image iconName={"spotify-client"} />
        <image iconName={"discord"} />
      </box>
    </button>
    <button cssName={"workspace"} cssClasses={["active"]}>
      <box>
        <label label="3" />
        <image iconName={"firefox"} />
        <image iconName={"nemo"} cssClasses={["urgent"]} />
      </box>
    </button >
  </box>
}


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
      heightRequest={40}
    >
      <centerbox cssName="centerbox">
        <box $type="start">
          <OSIcon />
          {workspaceWidget}

          <button
            $type="start"
            onClicked={() => execAsync("echo hello").then(console.log)}
            hexpand
            halign={Gtk.Align.CENTER}
          >
            <label label="Welcome to AGS!" />
          </button>
        </box>
        <menubutton $type="end" hexpand halign={Gtk.Align.CENTER}>
          <label label={time} />
          <popover>
            <Gtk.Calendar />
          </popover>
        </menubutton>
      </centerbox>
    </window>
  )
}
