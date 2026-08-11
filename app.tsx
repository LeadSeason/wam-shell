import GLib from "gi://GLib?version=2.0"
import app from "ags/gtk4/app"
import { createState, For, onCleanup } from "gnim"

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
// registers the "metrics" request command (inert unless WAM_SHELL_METRICS=1)
import "./src/lib/metrics"
// register their request commands at import (screenshot/record, keep-awake)
import "./src/lib/capture"
import "./src/lib/idleInhibit"
// request-driven windows register their toggle command at import and
// build their window lazily on first use instead of at startup
import "./src/widgets/notifications"
import "./src/widgets/mediaPopup"
import "./src/widgets/harvestPopup"
import "./src/widgets/sessionMenu"
import "./src/widgets/launcher"
import { init as initHarvest } from "./src/lib/harvest"
import { init as initGcal } from "./src/lib/gcal"
import { init as initGitHub } from "./src/lib/github"
import { init as initYouTube } from "./src/lib/youtube"
import { init as initTodoist } from "./src/lib/todoist"
import { init as initProtonmail } from "./src/lib/protonmail"
import { forceExitStreamedChildren } from "./src/lib/streamLines"
import { connect, disconnect } from "./src/lib/metrics"
import { runDisposers } from "./src/lib/lifecycle"

// The one place module teardown is actually called from.
//
// Every lib module owning long-lived sources registers a `dispose()`
// with lib/lifecycle at import; this runs the ones that were actually
// loaded. Streamed children go first and explicitly: with the read end
// of their stdout pipe gone they only die on their next write, and a
// quiet listener (mullvad between state changes) may never write again
// — that has to happen whether or not a disposer throws.
connect(app, "shutdown", () => {
    forceExitStreamedChildren()
    runDisposers()
})

function matchMonitor(wanted: string[], m: Gdk.Monitor): boolean {
    if (wanted.length === 0) return true
    const conn = m.get_connector() ?? ""
    const model = m.get_model() ?? ""
    const desc = m.get_description() ?? ""
    return wanted.some(w => w === conn || w === model || (w !== "" && desc.includes(w)))
}

function main() {
    // bundled fallback icons (assets/icons): core UI icon names must
    // resolve even when the system icon theme lacks them (old adwaita,
    // minimal/custom themes). System themes take precedence.
    Gtk.IconTheme.get_for_display(Gdk.Display.get_default()!).add_search_path(
        `${Config.instanceSrcDir}/assets/icons`,
    )

    initHarvest()
    initGcal()
    initGitHub()
    initYouTube()
    initTodoist()
    initProtonmail()

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

    // connector can be null (headless/nested backends): synthetic
    // per-object fallback ids so two such monitors can't key-collide
    const fallbackIds = new WeakMap<Gdk.Monitor, number>()
    let nextFallbackId = 0
    const monitorKey = (m: Gdk.Monitor): string => {
        const connector = m.get_connector()
        if (connector) return connector
        let id = fallbackIds.get(m)
        if (id === undefined) {
            id = nextFallbackId++
            fallbackIds.set(m, id)
        }
        return `monitor${id}`
    }

    // Gdk announces a hotplugged monitor with connector/description/
    // model all still null — they arrive in later notify:: emissions,
    // which app.monitors (items-changed only) does not refire on. A
    // [[panel]] monitors filter matching on those (a description
    // substring like "Acer") never matched a hotplugged monitor, so it
    // got no bar until the next monitor change came along. Track the
    // list here and bump it when the late properties land.
    const monitorModel = Gdk.Display.get_default()!.get_monitors()
    function readMonitors(): Gdk.Monitor[] {
        const out: Gdk.Monitor[] = []
        for (let i = 0; i < monitorModel.get_n_items(); i++)
            out.push(monitorModel.get_item(i) as Gdk.Monitor)
        return out
    }
    const [monitors, setMonitors] = createState<Gdk.Monitor[]>(readMonitors())
    const monitorHandlers = new Map<Gdk.Monitor, number[]>()
    // a monitor whose identity is fully known gets no more identity
    // updates — watching it would be a permanent connection that never
    // fires, so the watchers only exist while any property is null
    const identityKnown = (m: Gdk.Monitor) =>
        m.get_connector() !== null && m.get_description() !== null && m.get_model() !== null
    function syncMonitors() {
        const current = readMonitors()
        const present = new Set(current)
        for (const m of current) {
            if (identityKnown(m) || monitorHandlers.has(m)) continue
            monitorHandlers.set(m, [
                connect(m, "notify::connector", syncMonitors),
                connect(m, "notify::description", syncMonitors),
                connect(m, "notify::model", syncMonitors),
            ])
        }
        for (const [m, ids] of monitorHandlers) {
            if (present.has(m) && !identityKnown(m)) continue
            for (const id of ids) disconnect(m, id)
            monitorHandlers.delete(m)
        }
        setMonitors(current)
    }
    const itemsChangedHandler = connect(monitorModel, "items-changed", syncMonitors)
    syncMonitors()
    onCleanup(() => {
        disconnect(monitorModel, itemsChangedHandler)
        for (const [m, ids] of monitorHandlers) {
            for (const id of ids) disconnect(m, id)
        }
        monitorHandlers.clear()
    })

    const bars =
        Config.panels.length === 0 ? (
            // legacy mode: one bar per monitor, filtered by bar_monitors
            <For
                each={monitors.as(ms => ms.filter(m => matchMonitor(Config.barMonitors, m)))}
                cleanup={win => (win as Gtk.Window).destroy()}
            >
                {monitor => <Bar gdkMonitor={monitor} />}
            </For>
        ) : (
            // panel mode: one bar per matching [[panel]] per monitor
            <For
                each={monitors.as(ms =>
                    ms.flatMap(m =>
                        Config.panels
                            .map((panel, i) => ({ monitor: m, panel, i }))
                            .filter(p => matchMonitor(p.panel.monitors, p.monitor)),
                    ),
                )}
                // key by config index: two panels with the same position and
                // no class would otherwise collide and silently drop a bar.
                // get_connector() can be null (headless/nested backends):
                // two such monitors would produce the same "null/i" key —
                // fall back to a per-object synthetic id
                id={({ monitor, i }) => `${monitorKey(monitor)}/${i}`}
                cleanup={win => (win as Gtk.Window).destroy()}
            >
                {({ monitor, panel }) => <Bar gdkMonitor={monitor} panel={panel} />}
            </For>
        )

    const osds = !Config.osd.enabled ? null : (
        <For each={monitors} cleanup={win => (win as Gtk.Window).destroy()}>
            {monitor => <OSD gdkMonitor={monitor} />}
        </For>
    )

    const notifPopups = !(Config.notifications.popups && useOurs) ? null : (
        <For each={monitors} cleanup={win => (win as Gtk.Window).destroy()}>
            {monitor => <NotificationPopups gdkMonitor={monitor} />}
        </For>
    )

    return [bars, osds, notifPopups]
}

if (!GLib.file_test(Config.instanceCacheDir, GLib.FileTest.IS_DIR)) {
    // exists as a regular file, or the parent is unwritable: modules
    // that need the dir log their own failures — don't kill startup
    try {
        GLib.mkdir_with_parents(Config.instanceCacheDir, 0o755)
        console.log("Created dir:", Config.instanceCacheDir)
    } catch (e) {
        console.error("Failed to create cache dir:", e)
    }
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
