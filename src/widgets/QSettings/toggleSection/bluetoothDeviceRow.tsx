import { Accessor, createBinding, createComputed, createState, For, onCleanup, With } from "gnim"
import AstalBluetooth from "gi://AstalBluetooth?version=0.1"
import AstalWp from "gi://AstalWp?version=0.1"
import Pango from "gi://Pango?version=1.0"
import { Gtk } from "ags/gtk4"
import { batteryPercentValue } from "../../../lib/utils"
import { dismissPairingPrompt } from "../../../lib/bluetoothAgent"
import { advertises, sightings } from "../../../lib/bluetoothRange"
import { bluezErrorName, bluezErrorText } from "../../../lib/bluezErrors"
import {
    cancelPairingAsync,
    connectDeviceAsync,
    disconnectDeviceAsync,
    pairDeviceAsync,
    removeDeviceAsync,
} from "../../../lib/bluetoothCtl"
import { createDelayer } from "../../delay"

// null when PipeWire/WirePlumber is absent (see SliderSection's guard);
// the profile selector below dereferences wp.audio, so guard every use
const wp = AstalWp.get_default()

/** how long an error stays on the row before it clears itself */
const ERROR_MS = 4000

// Addresses whose pairing has failed once already, module-level because
// the row itself is rebuilt whenever the device list refreshes and would
// forget between attempts. Cleared on success, so a device that pairs and
// later fails starts its count over.
//
// This gates the forget-on-failure below, and the gate is the point: see
// dropFailedPairing.
const failedPairingOnce = new Set<string>()

/** audio profile (A2DP/HFP/…) selector for a connected bluetooth device,
 *  driven by the pipewire card (bluez_card.<MAC>) via AstalWp.
 *  Inline option rows rather than a Gtk.DropDown: dropdown popovers
 *  cannot grab the seat inside a layer-shell window with keymode
 *  EXCLUSIVE and close instantly */
function ProfileSelector({ wpDev }: { wpDev: AstalWp.Device }) {
    // tracked and cancelled on teardown (see widgets/delay.ts)
    const delay = createDelayer("btProfileSelector")
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
                                delay(5000, () => {
                                    if (token === pendingToken) setPendingProfile(null)
                                })
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
    /** true once the scan has run long enough to have heard anything
     *  that is actually in the room — only then may a paired device be
     *  called out of range (see the pane) */
    scanSettled: Accessor<boolean>
}

export function DeviceRow({ device, pauseDiscovery, maybeScan, scanSettled }: DeviceRowProps) {
    // tracked and cancelled on teardown (see widgets/delay.ts)
    const delay = createDelayer("btDeviceRow")
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
        delay(ERROR_MS, () => {
            if (token === errorToken) setError("")
        })
    }

    // the adapter is hearing this device right now (lib/bluetoothRange —
    // astal's own Device.rssi is always 0 and cannot answer this). A
    // connected device counts without a reading of its own
    const heard = sightings.as(m => m.has(device.address))
    // ...and whether its silence would mean anything. A device that has
    // never been heard advertising is not one we can call absent: plenty
    // never announce themselves at all, so the quiet is about them, not
    // about where they are. Both accessors derive from `sightings`, so
    // this re-evaluates whenever a sighting lands or ages out
    const canJudgeRange = sightings.as(() => advertises(device.address))

    const status = createComputed(
        [
            pending,
            error,
            createBinding(device, "connected"),
            createBinding(device, "paired"),
            createBinding(device, "batteryPercentage").as(batteryPercentValue),
            heard,
            canJudgeRange,
            scanSettled,
        ],
        (pending, error, connected, paired, battery, heard, judgeable, settled) => {
            if (error) return error
            if (pending === "pairing") return "Pairing…"
            if (pending === "connecting") return "Connecting…"
            if (pending === "disconnecting") return "Disconnecting…"
            if (connected) return battery >= 0 ? `Connected · ${battery}%` : "Connected"
            // Four states, because a paired device has three ways of not
            // being connected and they call for different actions:
            //
            //   Available     the adapter can hear it NOW — tap and it
            //                 connects. Same word the unpaired rows use,
            //                 because it is the same promise.
            //   Not in range  it normally announces itself and has gone
            //                 quiet: switched off, in its case, or in
            //                 another room. Tapping would sit on
            //                 "Connecting…" until bluez gave up.
            //   Paired        we genuinely cannot tell (it never
            //                 advertises, or the scan has not had its
            //                 thirteen seconds yet). Claim nothing.
            //
            // Collapsing the first and last was the original complaint
            // in miniature: a device you could connect to this second
            // looked identical to one whose whereabouts are unknown.
            if (!paired || heard) return "Available"
            if (settled && judgeable) return "Not in range"
            return "Paired"
        },
    )
    const statusClass = error.as(e => (e ? ["status", "error"] : ["status"]))
    const isPaired = createBinding(device, "paired")
    // dims the whole row to match the "Not in range" status
    const rowClasses = createComputed(
        [createBinding(device, "connected"), isPaired, heard, canJudgeRange, scanSettled],
        (connected, paired, heard, judgeable, settled) => {
            const classes = ["btDevice", "paneRow"]
            if (connected) classes.push("active")
            else if (paired && !heard && settled && judgeable) classes.push("unavailable")
            return classes
        },
    )

    async function connectFlow() {
        setPending("connecting")
        try {
            await connectDeviceAsync(device)
        } catch (e) {
            // a profile beat us to it (common straight after pairing):
            // that is the outcome we wanted
            if (bluezErrorName(e) !== "AlreadyConnected") {
                fail(bluezErrorText(e, "Connection failed"), e)
            }
        } finally {
            setPending("")
            maybeScan()
        }
    }

    async function disconnectFlow() {
        setPending("disconnecting")
        try {
            await disconnectDeviceAsync(device)
        } catch (e) {
            if (bluezErrorName(e) !== "NotConnected") {
                fail(bluezErrorText(e, "Disconnect failed"), e)
            }
        } finally {
            setPending("")
            maybeScan()
        }
    }

    async function pairFlow() {
        setPending("pairing")
        // guards this attempt's late work against a newer one on the
        // same device
        const attempt = ++pairAttempt
        try {
            await pairDeviceAsync(device)
        } catch (e) {
            // bluez answers AlreadyExists when the bond is already
            // there — there is nothing to pair, only to connect
            if (bluezErrorName(e) !== "AlreadyExists" && !device.paired) {
                if (attempt !== pairAttempt) return
                fail(bluezErrorText(e, "Pairing failed"), e)
                // bluez does not reliably cancel the agent prompt when
                // pairing fails, and does not stop trying on its own
                dismissPairingPrompt(device.address)
                // DoesNotExist here just means bluez had already given
                // up, which is the state we were asking for
                cancelPairingAsync(device).catch(() => {})
                dropFailedPairing(attempt)
                maybeScan()
                return
            }
        }
        if (attempt !== pairAttempt) return
        // paired: this device gets a clean slate, so a failure much later
        // is judged on its own rather than against an old grudge
        failedPairingOnce.delete(device.address)
        // bluez sets Paired before it answers Pair, so there is no
        // notify to wait for here — going straight on is also what
        // rescues a pairing that succeeded while the notify was missed
        await connectFlow()
    }

    /**
     * Forget a device that has now failed to pair TWICE.
     *
     * bluez keeps the half-built device object behind, and its stale
     * state makes the next Pair fail the same way — which is what turns
     * one failed attempt into a device that "keeps failing" until it is
     * removed by hand in bluetoothctl. Forgetting it is the fix.
     *
     * But forgetting is destructive, and a first failure is very often
     * something else entirely: a device that was not ready, a passkey
     * read too slowly, a radio busy with something else. Deleting a bond
     * over one bad moment is a much worse outcome than one more retry, so
     * the first failure is only remembered. The second is what shows the
     * device is genuinely wedged, and only that one clears it.
     *
     * Cleaning up at RETRY time instead would read better and does not
     * work: RemoveDevice destroys the object path, so there would be
     * nothing left to pair until bluez rediscovers it.
     *
     * Deferred by the length of the error message, because removing the
     * device takes this row with it.
     */
    function dropFailedPairing(attempt: number) {
        const address = device.address
        if (!failedPairingOnce.has(address)) {
            failedPairingOnce.add(address)
            return
        }
        delay(ERROR_MS, () => {
            if (attempt !== pairAttempt || device.paired) return
            failedPairingOnce.delete(address)
            removeDeviceAsync(device).catch(e =>
                console.warn("bluetooth: clearing a twice-failed pairing:", e),
            )
        })
    }

    function onClick() {
        if (pending.get()) return
        setError("")
        pauseDiscovery()
        // every branch resumes discovery when it settles (see maybeScan)
        if (device.connected) void disconnectFlow()
        else if (device.paired) void connectFlow()
        else void pairFlow()
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
    // 0 is the "in range, strength unknown" marker a connected device
    // gets, not a reading worth showing
    const rssi = sightings.as(m => m.get(device.address)?.rssi ?? 0)

    return (
        <box orientation={Gtk.Orientation.VERTICAL}>
            <box
                cssName={"button"}
                cssClasses={rowClasses}
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
                    {/* same expander pair as the wifi row's. Collapsed
                    it showed dialog-information — which in Adwaita is a
                    LIGHTBULB — so the control changed shape entirely
                    depending on which way it was pointing */}
                    <image
                        iconName={detailsOpen.as(o =>
                            o ? "pan-up-symbolic" : "pan-down-symbolic",
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
                    onClicked={() =>
                        removeDeviceAsync(device).catch(e =>
                            console.warn("bluetooth forget failed:", e),
                        )
                    }
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
                    <box visible={rssi.as(r => r !== 0)}>
                        <label cssClasses={["key"]} label={"Signal"} xalign={0} hexpand />
                        <label cssClasses={["value"]} label={rssi.as(r => `${r} dBm`)} xalign={1} />
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
                            {/* null, not <></> — see BtSwitch. This one
                            fires constantly: every device with no matching
                            pipewire card takes it */}
                            {(wpDev: AstalWp.Device | null) =>
                                wpDev ? <ProfileSelector wpDev={wpDev} /> : null
                            }
                        </With>
                    )}
                </box>
            </revealer>
        </box>
    )
}
