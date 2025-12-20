import GLib from "gi://GLib?version=2.0"
import app from "ags/gtk4/app"
import { createBinding, For } from "gnim"

import Bar from "./src/widgets/bar"
import Config from "./src/config"
import { compileScss } from "./src/lib/style"
import { requestHandler } from "./src/lib/requestHandler"
import { Gtk } from "ags/gtk4"
import swayScratchpad from "./src/widgets/sway-scratchpad"
import QSettings from "./src/widgets/QSettings"
import SwayGaps from "./src/lib/swayGaps"

let scratchpad:  Gtk.Window

function main() {
	if (Config.desktopSession == "sway")
		scratchpad = swayScratchpad() as Gtk.Window
	if (Config.swayGaps && Config.desktopSession == "sway")
    	SwayGaps.get_default()

    const monitors = createBinding(app, "monitors")
	const qSettings = QSettings() as Gtk.Window
	app.add_window(qSettings)
	
	return (<For each={monitors} cleanup={(win) => (win as Gtk.Window).destroy()}>
		{(monitor) => <Bar gdkMonitor={monitor} /> }
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

app.start({
	instanceName: Config.instanceName,
	css: Config.cssPath,
	requestHandler: requestHandler,
	main: main,
})
