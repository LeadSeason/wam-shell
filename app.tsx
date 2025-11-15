import GLib from "gi://GLib?version=2.0"
import app from "ags/gtk4/app"
import { createBinding, For } from "gnim"

import Bar from "./src/widgets/bar"
import Config from "./src/config"
import { compileScss } from "./src/lib/style"
import { requestHandler } from "./src/lib/requestHandler"
import { Gtk } from "ags/gtk4"
import Scratchpad from "./src/widgets/sway-scratchpad"

let scratchpad:  Gtk.Window

function main() {
	if (Config.desktopSession == "sway")
		scratchpad = Scratchpad() as Gtk.Window

    const monitors = createBinding(app, "monitors")
	
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
