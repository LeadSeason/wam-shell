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
import SwayGaps from "./src/lib/swayGaps"
import Dialog from "./src/widgets/dialog"
import BluetoothPairing from "./src/widgets/bluetoothPairing"
import { startBluetoothAgent } from "./src/lib/bluetoothAgent"
import NotificationPopups from "./src/widgets/notifications/popups"
import { useOurs } from "./src/lib/notifd"
// request-driven windows register their toggle command at import and
// build their window lazily on first use instead of at startup
import "./src/widgets/notifications"
import "./src/widgets/launcher"
import "./src/widgets/mediaPopup"


function matchMonitor(wanted: string[], m: Gdk.Monitor): boolean {
    if (wanted.length === 0) return true
    const conn = m.get_connector() ?? ""
    const model = m.get_model() ?? ""
    const desc = m.get_description() ?? ""
    return wanted.some(w =>
        w === conn || w === model || (w !== "" && desc.includes(w)))
}

function main() {
    // bundled fallback icons (assets/icons): core UI icon names must
    // resolve even when the system icon theme lacks them (old adwaita,
    // minimal/custom themes). System themes take precedence.
    Gtk.IconTheme.get_for_display(Gdk.Display.get_default()!)
        .add_search_path(`${Config.instanceSrcDir}/assets/icons`)

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
                .map((panel, i) => ({ monitor: m, panel, i }))
                .filter(p => matchMonitor(p.panel.monitors, p.monitor))))}
            // key by config index: two panels with the same position and
            // no class would otherwise collide and silently drop a bar
            id={({ monitor, i }) => `${monitor.get_connector()}/${i}`}
            cleanup={(win) => (win as Gtk.Window).destroy()}>
            {({ monitor, panel }) => <Bar gdkMonitor={monitor} panel={panel} />}
        </For>)

    const osds = !Config.osd.enabled ? null
        : (<For each={createBinding(app, "monitors")}
            cleanup={(win) => (win as Gtk.Window).destroy()}>
            {(monitor) => <OSD gdkMonitor={monitor} />}
        </For>)

    const notifPopups = !(Config.notifications.popups && useOurs) ? null
        : (<For each={createBinding(app, "monitors")}
            cleanup={(win) => (win as Gtk.Window).destroy()}>
            {(monitor) => <NotificationPopups gdkMonitor={monitor} />}
        </For>)

    return [bars, osds, notifPopups]
}

if (!GLib.file_test(Config.instanceCacheDir, GLib.FileTest.IS_DIR)) {
    GLib.mkdir_with_parents(Config.instanceCacheDir, 0o755);
    console.log("Created dir:", Config.instanceCacheDir)
}

// a style failure (missing sass, unreadable theme) must not take the
// whole shell down with it — reloadStyle already tolerates the same
try {
    compileScss()
} catch (e) {
    console.error("Failed to compile styles, starting unstyled:", e)
}

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
