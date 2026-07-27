import GLib from "gi://GLib?version=2.0"
import app from "ags/gtk4/app"
import { createBinding, For } from "gnim"

import Bar from "./src/widgets/bar"
import Config from "./src/config"
import { compileScss } from "./src/lib/style"
import { requestHandler } from "./src/lib/requestHandler"
import { Gtk, Gdk } from "ags/gtk4"
import swayScratchpad from "./src/widgets/sway-scratchpad"
import QSettings from "./src/widgets/QSettings"
import SwayGaps from "./src/lib/swayGaps"
import Dialog from "./src/widgets/dialog"


function matchMonitor(wanted: string[], m: Gdk.Monitor): boolean {
    if (wanted.length === 0) return true
    const conn = m.get_connector() ?? ""
    const model = m.get_model() ?? ""
    const desc = m.get_description() ?? ""
    return wanted.some(w =>
        w === conn || w === model || (w !== "" && desc.includes(w)))
}

function main() {
    if (Config.swayGaps && Config.desktopSession == "sway")
        SwayGaps.get_default()

    if (Config.desktopSession == "sway") {
        const scratchpad = swayScratchpad() as Gtk.Window
        app.add_window(scratchpad)
    }

    const dialog = Dialog.get_default()
    app.add_window(dialog.win)

    const qSettings = QSettings() as Gtk.Window
    app.add_window(qSettings)

    // legacy mode (no [[panel]] config): one bar per monitor, filtered
    // by bar_monitors (connector/model/description)
    if (Config.panels.length === 0) {
        const monitors = createBinding(app, "monitors").as(ms =>
            ms.filter(m => matchMonitor(Config.barMonitors, m)))
        return (<For each={monitors} cleanup={(win) => (win as Gtk.Window).destroy()}>
            {(monitor) => <Bar gdkMonitor={monitor} />}
        </For>)
    }

    // panel mode: one bar per matching [[panel]] per monitor
    const pairs = createBinding(app, "monitors").as(ms =>
        ms.flatMap(m => Config.panels
            .filter(p => matchMonitor(p.monitors, m))
            .map(panel => ({ monitor: m, panel }))))
    return (<For each={pairs} cleanup={(win) => (win as Gtk.Window).destroy()}>
        {({ monitor, panel }) => <Bar gdkMonitor={monitor} panel={panel} />}
    </For>)
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
