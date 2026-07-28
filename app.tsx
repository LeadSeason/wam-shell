import GLib from "gi://GLib?version=2.0"
import app from "ags/gtk4/app"
import { createBinding, For } from "gnim"

import Bar from "./src/widgets/bar"
import OSD from "./src/widgets/osd"
import Config from "./src/config"
import { compileScss } from "./src/lib/style"
import { requestHandler } from "./src/lib/requestHandler"
import { Gtk, Gdk } from "ags/gtk4"
import swayScratchpad from "./src/widgets/sway-scratchpad"
import QSettings from "./src/widgets/QSettings"
import Notifications from "./src/widgets/notifications"
import Launcher from "./src/widgets/launcher"
import SwayGaps from "./src/lib/swayGaps"
import Dialog from "./src/widgets/dialog"
import BluetoothPairing from "./src/widgets/bluetoothPairing"
import { startBluetoothAgent } from "./src/lib/bluetoothAgent"


function matchMonitor(wanted: string[], m: Gdk.Monitor): boolean {
    if (wanted.length === 0) return true
    const conn = m.get_connector() ?? ""
    const model = m.get_model() ?? ""
    const desc = m.get_description() ?? ""
    return wanted.some(w =>
        w === conn || w === model || (w !== "" && desc.includes(w)))
}

function main() {
    if (Config.swayGaps && (Config.desktopSession == "sway" || Config.desktopSession == "i3"))
        SwayGaps.get_default()

    if (Config.desktopSession == "sway") {
        const scratchpad = swayScratchpad() as Gtk.Window
        app.add_window(scratchpad)
    }

    const dialog = Dialog.get_default()
    app.add_window(dialog.win)

    const qSettings = QSettings() as Gtk.Window
    app.add_window(qSettings)

    app.add_window(Notifications() as Gtk.Window)
    app.add_window(Launcher() as Gtk.Window)
    app.add_window(BluetoothPairing() as Gtk.Window)
    startBluetoothAgent()

    const bars = Config.panels.length === 0
        // legacy mode: one bar per monitor, filtered by bar_monitors
        ? (<For each={createBinding(app, "monitors").as(ms =>
            ms.filter(m => matchMonitor(Config.barMonitors, m)))}
            cleanup={(win) => (win as Gtk.Window).destroy()}>
            {(monitor) => <Bar gdkMonitor={monitor} />}
        </For>)
        // panel mode: one bar per matching [[panel]] per monitor
        : (<For each={createBinding(app, "monitors").as(ms =>
            ms.flatMap(m => Config.panels
                .filter(p => matchMonitor(p.monitors, m))
                .map(panel => ({ monitor: m, panel }))))}
            id={({ monitor, panel }) =>
                `${monitor.get_connector()}/${panel.position}/${panel.class}`}
            cleanup={(win) => (win as Gtk.Window).destroy()}>
            {({ monitor, panel }) => <Bar gdkMonitor={monitor} panel={panel} />}
        </For>)

    const osds = !Config.osd.enabled ? null
        : (<For each={createBinding(app, "monitors")}
            cleanup={(win) => (win as Gtk.Window).destroy()}>
            {(monitor) => <OSD gdkMonitor={monitor} />}
        </For>)

    return [bars, osds]
}

if (!GLib.file_test(Config.instanceCacheDir, GLib.FileTest.IS_DIR)) {
    GLib.mkdir_with_parents(Config.instanceCacheDir, 0o755);
    console.log("Created dir:", Config.instanceCacheDir)
}

compileScss()

console.log("InstancePath:", Config.instanceSrcDir)
console.log("InstanceCacheDir:", Config.instanceCacheDir)
console.log("DesktopSession:", Config.desktopSession)
console.log("Workspaces:", JSON.stringify(Config.workspaces))

app.start({
    instanceName: Config.instanceName,
    css: Config.cssPath,
    requestHandler: requestHandler,
    main: main,
})
