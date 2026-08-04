import { createBinding, createComputed, createState, For, onCleanup, With } from "gnim"
import AstalBluetooth from "gi://AstalBluetooth?version=0.1"
import AstalWp from "gi://AstalWp?version=0.1"
import Pango from "gi://Pango?version=1.0"
import { Gtk } from "ags/gtk4"
import { batteryPercentValue } from "../../../lib/utils"
import { connect, disconnect } from "../../../lib/metrics"
import { dismissPairingPrompt } from "../../../lib/bluetoothAgent"
import { pairDeviceAsync, removeDeviceAsync } from "./bluez"

// null when PipeWire/WirePlumber is absent (see SliderSection's guard);
// the profile selector below dereferences wp.audio, so guard every use
const wp = AstalWp.get_default()

/** audio profile (A2DP/HFP/…) selector for a connected bluetooth device,
 *  driven by the pipewire card (bluez_card.<MAC>) via AstalWp.
 *  Inline option rows rather than a Gtk.DropDown: dropdown popovers
 *  cannot grab the seat inside a layer-shell window with keymode
 *  EXCLUSIVE and close instantly */
function ProfileSelector({ wpDev }: { wpDev: AstalWp.Device }) {
    // the switch takes ~1s to apply; mark the clicked profile pending
    // until activeProfileId catches up (5s safety timeout)
    const [pendingProfile, setPendingProfile] = createState<number | null>(null)
    let pendingToken = 0
    // the selector unmounts on every device disconnect/forget — without
    // this, each unmount leaks a notify handler on the wp Device
    onCleanup(createBinding(wpDev, "activeProfileId").subscribe(() => setPendingProfile(null)))

    const profiles = createComputed(
        [createBinding(wpDev, "profiles"), createBinding(wpDev, "activeProfileId"), pendingProfile],
        (list, activeId, pending) =>
            (list ?? [])
                // pipewire reports UNKNOWN availability for every profile —
                // only exclude explicit NO
                .filter(p => p.available !== AstalWp.Available.NO)
                .map(p => ({
                    index: p.index,
                    label: p.description ?? p.name,
                    active: p.index === activeId,
                    pending: p.index === pending,
                })),
    )

    return (
        <box orientation={Gtk.Orientation.VERTICAL}>
            <label cssClasses={["key"]} label={"Audio profile"} xalign={0} />
            <For each={profiles}>
                {p => (
                    <box
                        cssName={"button"}
                        cssClasses={p.active ? ["profileOption", "active"] : ["profileOption"]}
                        spacing={5}
                    >
                        <Gtk.GestureClick
                            button={1}
                            onPressed={() => {
                                if (p.active || pendingProfile.get() !== null) return
                                setPendingProfile(p.index)
                                const token = ++pendingToken
                                setTimeout(() => {
                                    if (token === pendingToken) setPendingProfile(null)
                                }, 5000)
                                wpDev.activeProfileId = p.index
                            }}
                        />
                        <label label={p.label} xalign={0} hexpand />
                        {p.active && <image iconName="object-select-symbolic" />}
                        {p.pending && <Gtk.Spinner $={self => self.start()} />}
                    </box>
                )}
            </For>
        </box>
    )
}

// "0000110a-0000-1000-8000-00805f9b34fb" -> "A2DP Sink"
const UUID_NAMES: Record<string, string> = {
    "1108": "HSP",
    "110a": "A2DP Sink",
    "110b": "A2DP Source",
    "110c": "AVRCP Target",
    "110d": "Advanced Audio",
    "110e": "AVRCP",
    "1112": "Headset AG",
    "111e": "HFP",
    "111f": "HFP AG",
    "1124": "HID",
    "1131": "HSP HS",
    "1132": "Message Access",
    "1105": "OBEX",
    "1106": "OBEX File Transfer",
    "1800": "GAP",
    "1801": "GATT",
    "180a": "Device Info",
    "180f": "Battery",
}
function uuidName(uuid: string): string {
    const m = uuid.match(/^0000([0-9a-f]{4})-/i)
    return m ? (UUID_NAMES[m[1].toLowerCase()] ?? m[1]) : uuid
}

// "audio-headphones" -> "Headphones"
function deviceType(icon: string): string {
    if (!icon) return "Unknown"
    const part = icon.includes("-") ? icon.split("-").slice(1).join(" ") : icon
    return part.charAt(0).toUpperCase() + part.slice(1)
}

interface DeviceRowProps {
    device: AstalBluetooth.Device
    /** stop discovery + clear the pane's scanning flag (pairing/connecting
     *  is slow and flaky while a scan is active) */
    pauseDiscovery: () => void
    /** resume pane-driven discovery after an attempt settles */
    maybeScan: () => void
}

export function DeviceRow({ device, pauseDiscovery, maybeScan }: DeviceRowProps) {
    const [pending, setPending] = createState<"" | "pairing" | "connecting" | "disconnecting">("")
    const [error, setError] = createState("")
    const [detailsOpen, setDetailsOpen] = createState(false)
    let errorToken = 0
    let pairAttempt = 0

    function fail(msg: string, e: unknown) {
        console.warn(`bluetooth: ${msg}:`, e)
        setPending("")
        setError(msg)
        const token = ++errorToken
        setTimeout(() => {
            if (token === errorToken) setError("")
        }, 4000)
    }

    const status = createComputed(
        [
            pending,
            error,
            createBinding(device, "connecting"),
            createBinding(device, "connected"),
            createBinding(device, "paired"),
            createBinding(device, "batteryPercentage").as(batteryPercentValue),
        ],
        (pending, error, connecting, connected, paired, battery) => {
            if (error) return error
            if (pending === "pairing") return "Pairing…"
            if (pending === "connecting" || connecting) return "Connecting…"
            if (pending === "disconnecting") return "Disconnecting…"
            if (connected) return battery >= 0 ? `Connected · ${battery}%` : "Connected"
            return paired ? "Paired" : "Available"
        },
    )
    const statusClass = error.as(e => (e ? ["status", "error"] : ["status"]))
    const isPaired = createBinding(device, "paired")

    // connect_device/disconnect_device REQUIRE an argument in gjs
    // (0-arg throws "At least 1 argument required"); use the async
    // callback form to also receive the result
    function connectDevice() {
        device.connect_device((_self: any, res: any) => {
            try {
                device.connect_device_finish(res)
            } catch (e) {
                fail("Connection failed", e)
            }
            setPending("")
            maybeScan()
        })
    }

    function onClick() {
        if (pending.get()) return
        setError("")
        pauseDiscovery()
        if (device.connected) {
            setPending("disconnecting")
            device.disconnect_device((_self: any, res: any) => {
                try {
                    device.disconnect_device_finish(res)
                } catch (e) {
                    fail("Disconnect failed", e)
                }
                setPending("")
                maybeScan()
            })
        } else if (device.paired) {
            setPending("connecting")
            connectDevice()
        } else {
            setPending("pairing")
            // token guards the timeout against a newer attempt on the
            // same device (a stale timeout must not fail the new one)
            const attempt = ++pairAttempt
            let handlerId = connect(device, "notify::paired", () => {
                if (!device.paired) return
                disconnect(device, handlerId)
                handlerId = 0
                setPending("connecting")
                connectDevice()
            })
            setTimeout(() => {
                // clean up this attempt's handler no matter what: a
                // superseded attempt must not leave it armed to
                // double-connect on success
                if (handlerId) {
                    disconnect(device, handlerId)
                    handlerId = 0
                }
                if (attempt !== pairAttempt) return
                if (pending.get() === "pairing") {
                    fail("Pairing failed", "timed out")
                    dismissPairingPrompt(device.address)
                    maybeScan()
                }
            }, 30_000)
            pairDeviceAsync(device).catch(e => {
                if (handlerId) {
                    disconnect(device, handlerId)
                    handlerId = 0
                }
                fail("Pairing failed", e)
                // bluez does not reliably cancel the agent prompt when
                // pairing fails — dismiss it ourselves
                dismissPairingPrompt(device.address)
            })
        }
    }

    const details: [string, string][] = [
        ["Address", device.address],
        ["Type", deviceType(device.icon)],
    ]
    if (device.modalias) details.push(["Modalias", device.modalias])
    // uuids only resolve once connected (services discovery) — bind
    // instead of baking them in at row construction
    const profilesText = createBinding(device, "uuids").as(uuids =>
        uuids.length ? [...new Set(uuids.map(uuidName))].join(", ") : "—",
    )

    return (
        <box orientation={Gtk.Orientation.VERTICAL}>
            <box
                cssName={"button"}
                cssClasses={createBinding(device, "connected").as(c =>
                    c ? ["btDevice", "paneRow", "active"] : ["btDevice", "paneRow"],
                )}
                spacing={5}
                tooltipText={createComputed(
                    [
                        createBinding(device, "connected"),
                        createBinding(device, "batteryPercentage").as(batteryPercentValue),
                    ],
                    (c, b) => (c && b >= 0 ? `${device.address} · ${b}%` : device.address),
                )}
            >
                {/* gesture only on the info area: nested buttons must not
                re-trigger the row click (see notification center) */}
                <box spacing={5} hexpand>
                    <Gtk.GestureClick button={1} onPressed={onClick} />
                    <image
                        iconName={createBinding(device, "icon").as(i => i || "bluetooth-symbolic")}
                        valign={Gtk.Align.START}
                    />
                    <box orientation={Gtk.Orientation.VERTICAL} hexpand>
                        <label
                            cssClasses={["paneRowName"]}
                            label={createBinding(device, "alias").as(a => a || device.name)}
                            xalign={0}
                        />
                        <label cssClasses={statusClass} label={status} xalign={0} />
                    </box>
                </box>
                <button
                    cssClasses={["details"]}
                    tooltipText={"Device details"}
                    onClicked={() => setDetailsOpen(!detailsOpen.get())}
                >
                    <image
                        iconName={detailsOpen.as(o =>
                            o ? "pan-up-symbolic" : "dialog-information-symbolic",
                        )}
                    />
                </button>
                <button
                    cssClasses={createBinding(device, "trusted").as(t =>
                        t ? ["trust", "active"] : ["trust"],
                    )}
                    visible={isPaired}
                    tooltipText={"Trusted"}
                    onClicked={() => {
                        device.trusted = !device.trusted
                    }}
                >
                    <image iconName="security-high-symbolic" />
                </button>
                <button
                    cssClasses={["forget"]}
                    visible={isPaired}
                    tooltipText={"Forget device"}
                    onClicked={() => removeDeviceAsync(device)}
                >
                    <image iconName="user-trash-symbolic" />
                </button>
            </box>
            <revealer
                revealChild={detailsOpen}
                transitionDuration={150}
                transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
            >
                <box cssClasses={["btDetails"]} orientation={Gtk.Orientation.VERTICAL}>
                    {details.map(([key, value]) => (
                        <box>
                            <label cssClasses={["key"]} label={key} xalign={0} hexpand />
                            <label
                                cssClasses={["value"]}
                                label={value}
                                xalign={1}
                                maxWidthChars={24}
                                ellipsize={Pango.EllipsizeMode.END}
                            />
                        </box>
                    ))}
                    <box>
                        <label cssClasses={["key"]} label={"Profiles"} xalign={0} hexpand />
                        <label
                            cssClasses={["value"]}
                            label={profilesText}
                            xalign={1}
                            maxWidthChars={24}
                            ellipsize={Pango.EllipsizeMode.END}
                        />
                    </box>
                    <box visible={createBinding(device, "rssi").as(r => r !== 0)}>
                        <label cssClasses={["key"]} label={"Signal"} xalign={0} hexpand />
                        <label
                            cssClasses={["value"]}
                            label={createBinding(device, "rssi").as(r => `${r} dBm`)}
                            xalign={1}
                        />
                    </box>
                    {/* pipewire card profiles (A2DP/HFP…), only exists
                    while the device is connected. The wp device has
                    no name/MAC — match by bluetooth icon + the
                    device description pipewire copies from bluez.
                    audio is null without PipeWire/WirePlumber,
                    and wp itself is null without WirePlumber */}
                    {wp?.audio && (
                        <With
                            value={createBinding(wp.audio, "devices").as(ds => {
                                const wanted = (device.alias || device.name).toLowerCase()
                                return (
                                    (ds ?? []).find(
                                        d =>
                                            d.icon?.includes("bluetooth") &&
                                            d.description?.toLowerCase() === wanted,
                                    ) ?? null
                                )
                            })}
                        >
                            {wpDev => wpDev && <ProfileSelector wpDev={wpDev} />}
                        </With>
                    )}
                </box>
            </revealer>
        </box>
    )
}
