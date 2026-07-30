// Exercises the metrics wrappers, then queries the "metrics" command
// through the real CommandRegistry and prints the responses, so
// metrics.test.ts can assert them per scenario (env-controlled).
import GLib from "gi://GLib?version=2.0"
import GObject from "gi://GObject?version=2.0"
import CommandRegistry from "../src/lib/commandRegistry"
import {
    exec, execAsync, timeoutAdd, timeoutAddSeconds,
    sourceRemove, connect, disconnect, trackHttp,
} from "../src/lib/metrics"

exec("true")
execAsync("true")

timeoutAdd("probe:oneshot", GLib.PRIORITY_DEFAULT, 60000, () => GLib.SOURCE_REMOVE)
const removed = timeoutAdd("probe:oneshot", GLib.PRIORITY_DEFAULT, 60000,
    () => GLib.SOURCE_REMOVE)
timeoutAddSeconds("probe:seconds", GLib.PRIORITY_DEFAULT, 60, () => GLib.SOURCE_REMOVE)
sourceRemove(removed)

const obj = new GObject.Object()
connect(obj, "notify", () => { })
const gone = connect(obj, "notify", () => { })
disconnect(obj, gone)

trackHttp("https://api.example.com/v1/x", 512)
trackHttp("https://api.example.com/v1/y", 256)

const registry = CommandRegistry.get_default()
const loop = new GLib.MainLoop(null, false)

registry.execute(["metrics"]).then((snap) => {
    print("SNAP " + snap)
    return registry.execute(["metrics", "reset"])
}).then((reset) => {
    print("RESET " + reset)
    return registry.execute(["metrics"])
}).then((snap2) => {
    print("SNAP2 " + snap2)
    loop.quit()
}).catch((e) => {
    printerr("probe failed:", e)
    loop.quit()
})

loop.run()
