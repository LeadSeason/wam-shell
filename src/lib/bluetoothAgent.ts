import Gio from "gi://Gio?version=2.0"
import GLib from "gi://GLib?version=2.0"
import { createState } from "gnim"
import bluetooth from "./bluetooth"
import { timeoutAdd, sourceRemove, connect, disconnect } from "./metrics"

// BlueZ pairing agent (org.bluez.Agent1): answers confirmation / PIN /
// passkey prompts during pairing. The GTK side lives in
// widgets/bluetoothPairing.tsx and renders pairingRequest.

const AGENT_PATH = "/com/wamshell/bluetooth/agent"
const CAPABILITY = "KeyboardDisplay"
const PROMPT_TIMEOUT_MS = 30_000

export interface PairingRequest {
    kind: "confirm" | "pin" | "passkey" | "display" | "authorize"
    deviceName: string
    /** MAC address of the device being paired */
    deviceAddress: string
    icon: string
    /** passkey to show for "confirm" and "display" */
    code?: string
    /** exactly-once answer back to bluez */
    respond: (accept: boolean, input?: string) => void
}

export const [pairingRequest, setPairingRequest] = createState<PairingRequest | null>(null)

/** true while the QS bluetooth pane is on screen: the prompt renders
 *  inline in the pane; otherwise the floating dialog window shows it */
export const [btPaneOpen, setBtPaneOpen] = createState(false)

/** dismiss the prompt (and any queued prompts) for a device — bluez does
 *  not reliably send Cancel when pairing fails, so the initiator calls
 *  this when it learns the attempt failed */
export function dismissPairingPrompt(address: string) {
    const current = pairingRequest.get()
    if (current?.deviceAddress === address) current.respond(false)
    for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].deviceAddress === address) queue.splice(i, 1)[0].respond(false)
    }
}

const AGENT_XML = `<node>
  <interface name="org.bluez.Agent1">
    <method name="Release"/>
    <method name="RequestPinCode">
      <arg name="device" type="o" direction="in"/>
      <arg name="pincode" type="s" direction="out"/>
    </method>
    <method name="DisplayPinCode">
      <arg name="device" type="o" direction="in"/>
      <arg name="pincode" type="s" direction="in"/>
    </method>
    <method name="RequestPasskey">
      <arg name="device" type="o" direction="in"/>
      <arg name="passkey" type="u" direction="out"/>
    </method>
    <method name="DisplayPasskey">
      <arg name="device" type="o" direction="in"/>
      <arg name="passkey" type="u" direction="in"/>
      <arg name="entered" type="q" direction="in"/>
    </method>
    <method name="RequestConfirmation">
      <arg name="device" type="o" direction="in"/>
      <arg name="passkey" type="u" direction="in"/>
    </method>
    <method name="RequestAuthorization">
      <arg name="device" type="o" direction="in"/>
    </method>
    <method name="AuthorizeService">
      <arg name="device" type="o" direction="in"/>
      <arg name="uuid" type="s" direction="in"/>
    </method>
    <method name="Cancel"/>
  </interface>
</node>`

const queue: PairingRequest[] = []

function deviceInfo(path: string): { name: string; icon: string; address: string } {
    const mac = path.match(/dev_([0-9A-Fa-f_]+)$/)?.[1].replaceAll("_", ":") ?? ""
    const device = bluetooth.devices.find(d => d.address === mac)
    return {
        name: device ? device.alias || device.name || mac : mac || path,
        icon: device?.icon || "bluetooth-symbolic",
        address: mac,
    }
}

/** show the request, or queue it behind the current one */
function present(req: PairingRequest) {
    if (pairingRequest.get() === null) {
        setPairingRequest(req)
        // the prompt is visible now — its timeout starts here, not at
        // enqueue time, or queued prompts expire before being shown
        armByRespond.get(req.respond)?.()
    } else {
        queue.push(req)
    }
}

// respond fn -> arm fn: starts the bluez answer timeout once the
// request is the active prompt
const armByRespond = new Map<PairingRequest["respond"], () => void>()

/** wrap an invocation answer with queue advance and exactly-once */
function makeResponder(
    invocation: Gio.DBusMethodInvocation | null,
    acceptVariant: (input?: string) => GLib.Variant | null,
): PairingRequest["respond"] {
    let done = false
    let timer = 0

    const advance = () => {
        setPairingRequest(null)
        const next = queue.shift()
        if (next) {
            setPairingRequest(next)
            armByRespond.get(next.respond)?.()
        }
    }

    const finish = (accept: boolean, input?: string) => {
        if (done) return
        done = true
        armByRespond.delete(finish)
        if (timer) {
            sourceRemove(timer)
            timer = 0
        }
        if (invocation) {
            try {
                if (accept) {
                    invocation.return_value(acceptVariant(input))
                } else {
                    invocation.return_dbus_error(
                        "org.bluez.Error.Rejected",
                        "Pairing rejected by user",
                    )
                }
            } catch (e) {
                console.warn("bluetooth agent: reply failed:", e)
            }
        }
        // a queued request answering early (dismissPairingPrompt) must
        // not advance past — and kill — the active prompt
        if (pairingRequest.get()?.respond === finish) advance()
    }

    // bluez cancels the pairing if the agent does not answer in time.
    // Armed when the prompt becomes active (see present/advance), not
    // here — a queued prompt must not expire unseen. Display requests
    // have no invocation to answer, but must still expire or they
    // wedge the queue forever.
    armByRespond.set(finish, () => {
        if (timer || done) return
        timer = timeoutAdd(
            "btAgent:promptTimeout",
            GLib.PRIORITY_DEFAULT,
            PROMPT_TIMEOUT_MS,
            () => {
                timer = 0
                if (done) return GLib.SOURCE_REMOVE
                done = true
                armByRespond.delete(finish)
                if (invocation) {
                    try {
                        invocation.return_dbus_error(
                            "org.bluez.Error.Canceled",
                            "Pairing prompt timed out",
                        )
                    } catch (e) {
                        console.warn("bluetooth agent: timeout reply failed:", e)
                    }
                }
                advance()
                return GLib.SOURCE_REMOVE
            },
        )
    })
    return finish
}

function onMethodCall(
    _conn: Gio.DBusConnection,
    _sender: string,
    _path: string,
    _iface: string,
    method: string,
    params: GLib.Variant,
    invocation: Gio.DBusMethodInvocation,
) {
    const { name, icon, address } = deviceInfo(
        method === "Cancel" || method === "Release"
            ? ""
            : params.get_child_value(0).get_string()[0],
    )

    switch (method) {
        case "Release":
            invocation.return_value(null)
            break
        case "Cancel":
            // bluez aborted the current pairing: drop the open prompt
            if (pairingRequest.get() !== null) pairingRequest.get()!.respond(false)
            invocation.return_value(null)
            break
        case "RequestConfirmation": {
            const passkey = params.get_child_value(1).get_uint32()
            present({
                kind: "confirm",
                deviceName: name,
                deviceAddress: address,
                icon,
                code: passkey.toString().padStart(6, "0"),
                respond: makeResponder(invocation, () => null),
            })
            break
        }
        case "RequestAuthorization":
            present({
                kind: "authorize",
                deviceName: name,
                deviceAddress: address,
                icon,
                respond: makeResponder(invocation, () => null),
            })
            break
        case "RequestPinCode":
            present({
                kind: "pin",
                deviceName: name,
                deviceAddress: address,
                icon,
                respond: makeResponder(invocation, input => new GLib.Variant("(s)", [input ?? ""])),
            })
            break
        case "RequestPasskey":
            present({
                kind: "passkey",
                deviceName: name,
                deviceAddress: address,
                icon,
                respond: makeResponder(
                    invocation,
                    input => new GLib.Variant("(u)", [Number(input ?? "0")]),
                ),
            })
            break
        case "DisplayPinCode":
        case "DisplayPasskey": {
            const code =
                method === "DisplayPinCode"
                    ? params.get_child_value(1).get_string()[0]
                    : params.get_child_value(1).get_uint32().toString().padStart(6, "0")
            // no answer expected: return now, Close just dismisses the dialog
            invocation.return_value(null)
            present({
                kind: "display",
                deviceName: name,
                deviceAddress: address,
                icon,
                code,
                respond: makeResponder(null, () => null),
            })
            break
        }
        case "AuthorizeService":
            // standard desktop-agent behavior: allow
            invocation.return_value(null)
            break
        default:
            invocation.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", method)
    }
}

let registered = false
let registering = false
let retried = false

function register() {
    // watch_name fires "appeared" at setup while the first call is still
    // in flight — never run two registrations concurrently
    if (registered || registering) return
    registering = true
    // async like every other bluez call: a sync call here can freeze the
    // whole shell at startup when bluez is slow
    Gio.DBus.system.call(
        "org.bluez",
        "/org/bluez",
        "org.bluez.AgentManager1",
        "RegisterAgent",
        new GLib.Variant("(os)", [AGENT_PATH, CAPABILITY]),
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (_c, res) => {
            try {
                Gio.DBus.system.call_finish(res)
            } catch (e) {
                registering = false
                // a just-killed instance's agent registration lingers on
                // the bus briefly — retry once instead of giving up
                if (!retried && (e as Error).message?.includes("AlreadyExists")) {
                    retried = true
                    timeoutAdd("btAgent:registerRetry", GLib.PRIORITY_DEFAULT, 2000, () => {
                        register()
                        return GLib.SOURCE_REMOVE
                    })
                    return
                }
                registered = false
                console.warn(
                    "bluetooth: agent registration failed " + "(pairing degrades to just-works):",
                    e,
                )
                return
            }
            Gio.DBus.system.call(
                "org.bluez",
                "/org/bluez",
                "org.bluez.AgentManager1",
                "RequestDefaultAgent",
                new GLib.Variant("(o)", [AGENT_PATH]),
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (_c2, res2) => {
                    registering = false
                    try {
                        Gio.DBus.system.call_finish(res2)
                        registered = true
                        retried = false // next failure gets its own retry
                        console.log("bluetooth: pairing agent registered")
                    } catch (e) {
                        registered = false
                        // one bounded retry per failure (bluez restart
                        // races, transient bus errors) — otherwise the
                        // agent is silently dead for the session
                        if (!retried) {
                            retried = true
                            timeoutAdd("btAgent:registerRetry", GLib.PRIORITY_DEFAULT, 2000, () => {
                                register()
                                return GLib.SOURCE_REMOVE
                            })
                            return
                        }
                        console.warn("bluetooth: default agent request failed:", e)
                    }
                },
            )
        },
    )
}

export function startBluetoothAgent() {
    if (!bluetooth.adapter) {
        // the adapter can appear later (rfkill at login, bluez starting
        // after the shell): retry when it shows up, once
        const id = connect(bluetooth, "notify::adapter", () => {
            if (bluetooth.adapter) {
                disconnect(bluetooth, id)
                startBluetoothAgent()
            }
        })
        return
    }
    const info = Gio.DBusInterfaceInfo.new_for_xml(AGENT_XML)
    Gio.DBus.system.register_object(AGENT_PATH, info, onMethodCall, null, null)
    register()
    // re-register if bluez restarts
    Gio.DBus.watch_name(
        Gio.BusType.SYSTEM,
        "org.bluez",
        Gio.BusNameWatcherFlags.NONE,
        () => {
            if (!registered) register()
        },
        () => {
            registered = false
        },
    )
}
