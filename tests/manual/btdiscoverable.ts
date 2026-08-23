// Manual harness for the pane's discoverable tracking. Not a gate — it
// imports lib/bluetoothCtl, which opens the SYSTEM bus at import and
// talks to the real bluez.
//
// The bug this covers cannot be seen by looking at our own writes: the
// old checkbox was bound to AstalBluetooth's Adapter object, which stops
// being told anything once astal swaps it (a bluetoothd restart), so it
// went stale against changes made ANYWHERE ELSE. So the interesting case
// is an EXTERNAL change — set over the bus, behind the shell's back —
// and whether the accessor follows it.
//
// It moves the real adapter's Discoverable, because that is the thing
// under test, and puts it back where it found it.

import Gio from "gi://Gio?version=2.0"
import GLib from "gi://GLib?version=2.0"
import System from "system"
import {
    discoverable,
    acquireDiscoverable,
    toggleDiscoverable,
    dispose,
} from "../../src/lib/bluetoothCtl"

const PATH = "/org/bluez/hci0"
const IFACE = "org.bluez.Adapter1"

let failed = 0
function eq(what: string, got: unknown, want: unknown) {
    if (got === want) print(`  ok    ${what}`)
    else {
        failed++
        print(`  FAIL  ${what} — got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`)
    }
}

/** spin the real main loop: the tracker answers on bus callbacks */
function pump(ms: number) {
    const loop = new GLib.MainLoop(null, false)
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        loop.quit()
        return GLib.SOURCE_REMOVE
    })
    loop.run()
}

/** read Discoverable straight from bluez, bypassing everything of ours */
function busGet(): boolean {
    const reply = Gio.DBus.system.call_sync(
        "org.bluez",
        PATH,
        "org.freedesktop.DBus.Properties",
        "Get",
        new GLib.Variant("(ss)", [IFACE, "Discoverable"]),
        null,
        Gio.DBusCallFlags.NONE,
        5000,
        null,
    )
    return reply.get_child_value(0).get_variant().get_boolean()
}

/** and write it the same way — an external change, as far as we know */
function busSet(value: boolean) {
    Gio.DBus.system.call_sync(
        "org.bluez",
        PATH,
        "org.freedesktop.DBus.Properties",
        "Set",
        new GLib.Variant("(ssv)", [IFACE, "Discoverable", new GLib.Variant("b", value)]),
        null,
        Gio.DBusCallFlags.NONE,
        5000,
        null,
    )
}

let original: boolean
try {
    original = busGet()
} catch (e) {
    print(`ABORT: no adapter at ${PATH}: ${e}`)
    System.exit(2)
}
print(`adapter ${PATH}, Discoverable=${original}\n`)

try {
    print("the tracker starts from what bluez actually says")
    const release = acquireDiscoverable()
    pump(1500)
    eq("initial value read", discoverable.get(), original)

    print("an EXTERNAL change — the case the old binding went stale on")
    busSet(!original)
    pump(1500)
    eq("followed the change", discoverable.get(), !original)
    eq("and bluez agrees", busGet(), !original)

    print("and back")
    busSet(original)
    pump(1500)
    eq("followed the change back", discoverable.get(), original)

    print("our own write lands, and comes back through the same path")
    toggleDiscoverable()
    pump(2000)
    eq("bluez was actually told", busGet(), !original)
    eq("and the accessor followed", discoverable.get(), !original)

    toggleDiscoverable()
    pump(2000)
    eq("toggled back", busGet(), original)
    eq("accessor back", discoverable.get(), original)

    print("released: the subscription is gone, not merely ignored")
    release()
    busSet(!original)
    pump(1500)
    eq("stopped following", discoverable.get(), original)
    eq("though bluez really did change", busGet(), !original)
} finally {
    // put the adapter back exactly as it was found
    try {
        busSet(original)
    } catch (e) {
        print(`WARNING: could not restore Discoverable=${original}: ${e}`)
    }
    dispose()
}

eq("restored", busGet(), original)
print(failed === 0 ? "\nPASS" : `\n${failed} FAILED`)
System.exit(failed === 0 ? 0 : 1)
