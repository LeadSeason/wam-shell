// Manual harness for the bluetooth power toggle's debounce and its
// failure path. Not a gate — it imports lib/bluetooth, which opens the
// SYSTEM bus and talks to the real bluez at import.
//
// The thing being checked cannot be seen from the UI: a second click
// during a transition is refused, and refusing it looks exactly like
// honouring it (togglePowered reads bluez's own Powered, which has not
// moved yet, so both clicks would ask for the SAME target anyway). The
// difference is one D-Bus Set instead of two, plus one settle timer and
// one signal handler instead of a leaked pair. So this counts the calls.
//
// Gio.DBus.system.call is stubbed and NEVER answered, which is both how
// the calls get counted and why the real adapter is never touched: the
// harness leaves bluez exactly as it found it. The stub is verified to
// be in place before anything is toggled, and the run aborts if it is
// not, rather than risk driving the live adapter.

import Gio from "gi://Gio?version=2.0"
import GLib from "gi://GLib?version=2.0"
import System from "system"
import bluetooth from "../../src/lib/bluetooth"
import {
    setPoweredAsync,
    togglePowered,
    powerPending,
    powerError,
} from "../../src/lib/bluetoothCtl"

let failed = 0
function check(what: string, ok: boolean, detail = "") {
    if (ok) print(`  ok    ${what}`)
    else {
        failed++
        print(`  FAIL  ${what}${detail ? ` — ${detail}` : ""}`)
    }
}
function eq(what: string, got: unknown, want: unknown) {
    check(what, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`)
}

/** spin the real main loop for ms — the module runs on GLib timers */
function pump(ms: number) {
    const loop = new GLib.MainLoop(null, false)
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        loop.quit()
        return GLib.SOURCE_REMOVE
    })
    loop.run()
}

const bus = Gio.DBus.system
const calls: string[] = []
const sets = () => calls.filter(c => c.startsWith("Set "))
const realCall = bus.call

// Only the WRITE is intercepted. A Properties.Set on the adapter is
// recorded and then dropped on the floor — that is both how the calls
// get counted and why the real adapter is never touched: with the reply
// never arriving, bluez is mid-transition for as long as this harness
// cares to look, and it ends the run exactly as it started it.
// Everything else (the ObjectManager lookup that resolves the adapter's
// object path) is forwarded to the real bus, because it is read-only and
// because swallowing it would leave the module retrying it forever.
;(bus as unknown as { call: unknown }).call = function (
    this: Gio.DBusConnection,
    ...args: unknown[]
) {
    const [, , iface, method, params] = args as [
        string,
        string,
        string,
        string,
        GLib.Variant | null,
    ]
    if (iface === "org.freedesktop.DBus.Properties" && method === "Set") {
        calls.push(`Set ${params ? params.print(false) : ""}`)
        return
    }
    calls.push(`${iface}.${method}`)
    return (realCall as Function).apply(this, args)
}

// If assigning over the method did not take, every toggle below would go
// to the real bluez and this would power the machine's adapter down for
// real. Prove the interception first, and bail out if it is not there.
bus.call(
    "org.bluez",
    "/",
    "org.freedesktop.DBus.Properties",
    "Set",
    null,
    null,
    Gio.DBusCallFlags.NONE,
    1000,
    null,
    () => {},
)
if (sets().length !== 1) {
    print("ABORT: could not intercept Gio.DBus.system.call — refusing to drive the real adapter")
    System.exit(2)
}
calls.length = 0

// the adapter can arrive a beat after get_default()
if (!bluetooth.adapter) pump(1000)
if (!bluetooth.adapter) {
    print("ABORT: no bluetooth adapter")
    System.exit(2)
}

const powered = bluetooth.is_powered
// aim AWAY from where the adapter already is, so bluez confirming
// nothing is indistinguishable from bluez being slow — which is the
// state a debounce has to survive
const target = !powered
const summary = target ? "Could not turn on" : "Could not turn off"
print(`adapter ${bluetooth.adapter.address}, powered=${powered}, aiming at ${target}\n`)

print("click 1 — starts the transition")
setPoweredAsync(target)
eq("one Set issued", sets().length, 1)
eq(
    "…and it asks for Powered=" + target,
    sets()[0],
    `Set ('org.bluez.Adapter1', 'Powered', <${target}>)`,
)
eq("pending shows the target immediately", powerPending.get(), target)

print("clicks 2-4 — impatient, mid-transition")
setPoweredAsync(target)
togglePowered()
setPoweredAsync(!target)
eq("still one Set", sets().length, 1)
eq("pending unchanged", powerPending.get(), target)
eq("no error shown", powerError.get(), "")

print("bluez never answers — the settle timeout gives up (10s)")
pump(10_500)
eq("pending cleared", powerPending.get(), null)
eq("failure is said out loud", powerError.get(), summary)
eq("still one Set", sets().length, 1)

print("the error clears itself (4s)")
pump(4_500)
eq("error gone", powerError.get(), "")

print("click 5 — after the attempt ended, the toggle works again")
setPoweredAsync(target)
eq("a second Set is issued", sets().length, 2)
eq("pending shows the target", powerPending.get(), target)

// leave nothing running
;(bus as unknown as { call: unknown }).call = realCall
pump(10_500)
eq("nothing left pending", powerPending.get(), null)
eq("adapter untouched", bluetooth.is_powered, powered)

print(`\nbus calls: ${calls.join(" | ")}`)
print(failed === 0 ? "PASS" : `${failed} FAILED`)
System.exit(failed === 0 ? 0 : 1)
