import { Accessor, createBinding, createComputed, createState, For, With } from "gnim";
import { DropdownButton } from "./ToggleButton";
import AstalBluetooth from "gi://AstalBluetooth?version=0.1";
import Gio from "gi://Gio?version=2.0";
import GLib from "gi://GLib?version=2.0";
import Pango from "gi://Pango?version=1.0";
import { Gtk } from "ags/gtk4";
import bluetooth from "../../../lib/bluetooth";
import { pairingRequest, setBtPaneOpen, dismissPairingPrompt } from "../../../lib/bluetoothAgent";
import { PromptContent } from "../../bluetoothPairing";
import AstalWp from "gi://AstalWp?version=0.1";

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
    createBinding(wpDev, "activeProfileId").subscribe(() => setPendingProfile(null))

    const profiles = createComputed(
        [createBinding(wpDev, "profiles"), createBinding(wpDev, "activeProfileId"), pendingProfile],
        (list, activeId, pending) => (list ?? [])
            // pipewire reports UNKNOWN availability for every profile —
            // only exclude explicit NO
            .filter(p => p.available !== AstalWp.Available.NO)
            .map(p => ({
                index: p.index,
                label: p.description ?? p.name,
                active: p.index === activeId,
                pending: p.index === pending,
            })))

    return <box orientation={Gtk.Orientation.VERTICAL}>
        <label cssClasses={["key"]} label={"Audio profile"} xalign={0} />
        <For each={profiles}>
            {(p) =>
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
                    {p.pending && <Gtk.Spinner $={(self) => self.start()} />}
                </box>
            }
        </For>
    </box>
}

// AstalBluetooth's pair() and Adapter.remove_device() are SYNC D-Bus
// calls: they block the whole main loop, which froze the shell and
// queued agent prompts behind the block. Call bluez async instead.
function devicePath(device: AstalBluetooth.Device): string {
    return `${device.adapter}/dev_${device.address.replaceAll(":", "_")}`
}

function systemCallFinish(res: Gio.AsyncResult): void {
    Gio.DBus.system.call_finish(res)
}

function pairDeviceAsync(device: AstalBluetooth.Device): Promise<void> {
    return new Promise((resolve, reject) => {
        Gio.DBus.system.call(
            "org.bluez", devicePath(device), "org.bluez.Device1", "Pair",
            null, null, Gio.DBusCallFlags.NONE, -1, null,
            (_conn, res) => {
                try { systemCallFinish(res); resolve() } catch (e) { reject(e) }
            },
        )
    })
}

function removeDeviceAsync(device: AstalBluetooth.Device): void {
    Gio.DBus.system.call(
        "org.bluez", `${device.adapter}`, "org.bluez.Adapter1", "RemoveDevice",
        new GLib.Variant("(o)", [devicePath(device)]),
        null, Gio.DBusCallFlags.NONE, -1, null,
        (_conn, res) => {
            try {
                systemCallFinish(res)
            } catch (e) {
                console.warn("bluetooth forget failed:", e)
            }
        },
    )
}

// the adapter's own object path is not exposed; derive it from any device
function adapterPath(): string {
    return `${bluetooth.devices[0]?.adapter ?? "/org/bluez/hci0"}`
}

// discovery start/stop must also be async: the sync versions block the
// main loop (observed 25s) when bluez is busy e.g. pairing
function startDiscoveryAsync(): void {
    Gio.DBus.system.call(
        "org.bluez", adapterPath(), "org.bluez.Adapter1", "StartDiscovery",
        null, null, Gio.DBusCallFlags.NONE, -1, null,
        (_conn, res) => {
            try {
                systemCallFinish(res)
            } catch (e) {
                // benign: already discovering (proxy property can be stale)
                if ((e as Error).message?.includes("already in progress")) return
                console.warn("bluetooth start discovery failed:", e)
            }
        },
    )
}

function stopDiscoveryAsync(): void {
    Gio.DBus.system.call(
        "org.bluez", adapterPath(), "org.bluez.Adapter1", "StopDiscovery",
        null, null, Gio.DBusCallFlags.NONE, -1, null,
        (_conn, res) => {
            try {
                systemCallFinish(res)
            } catch (e) {
                // benign: the discovering proxy property can be stale
                if ((e as Error).message?.includes("No discovery started")) return
                console.warn("bluetooth stop discovery failed:", e)
            }
        },
    )
}

interface btPaneProps {
    /** current pane name, discovery runs while this pane is visible */
    pane: Accessor<string>
    name: string
}

export function BluetoothButton({ navigate }: { navigate: () => void }) {
    // no bluetooth adapter on this machine
    if (!bluetooth.adapter) return <></>

    // battery only re-evaluates when the device list or power changes;
    // good enough for a subtitle
    const subtitle = createComputed(
        [createBinding(bluetooth, "is_powered"), createBinding(bluetooth, "devices")],
        (powered, devices) => {
            if (!powered) return "Off"
            const connected = devices.find(d => d.connected)
            if (!connected) return "On"
            const name = connected.alias || connected.name
            const battery = connected.batteryPercentage
            return battery >= 0 ? `${name} · ${battery}%` : name
        }
    )

    const icon = createBinding(bluetooth, "is_connected")
        .as(connected => connected ? "bluetooth-active-symbolic" : "bluetooth-symbolic")

    return <DropdownButton
        navigate={navigate}
        icon={icon}
        label={"Bluetooth"}
        subtitle={subtitle}
        isActive={createBinding(bluetooth, "is_powered")}
        activate={() => {
            const adapter = bluetooth.adapter
            if (adapter) adapter.powered = !adapter.powered
        }}
    />
}

// "0000110a-0000-1000-8000-00805f9b34fb" -> "A2DP Sink"
const UUID_NAMES: Record<string, string> = {
    "1108": "HSP", "110a": "A2DP Sink", "110b": "A2DP Source",
    "110c": "AVRCP Target", "110d": "Advanced Audio", "110e": "AVRCP",
    "1112": "Headset AG", "111e": "HFP", "111f": "HFP AG",
    "1124": "HID", "1131": "HSP HS", "1132": "Message Access",
    "1105": "OBEX", "1106": "OBEX File Transfer",
    "1800": "GAP", "1801": "GATT", "180a": "Device Info", "180f": "Battery",
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

export function BluetoothWidget({ pane, name }: btPaneProps) {
    const adapter = bluetooth.adapter
    if (!adapter) return <></>

    // brief pulse so a rescan click gives visible feedback (discovery is
    // already running while the pane is open, so adapter.discovering
    // alone can't show it)
    const [rescanning, setRescanning] = createState(false)
    let rescanToken = 0

    function rescan() {
        stopDiscoveryAsync()
        startDiscoveryAsync()
        setScanning(true)
        setRescanning(true)
        const token = ++rescanToken
        setTimeout(() => { if (token === rescanToken) setRescanning(false) }, 3000)
    }

    // adapter.discovering is a proxy property that provably goes stale
    // (bluez said "No discovery started" while it read true) — never gate
    // calls on it; issue start/stop unconditionally (bluez errors on the
    // redundant ones are filtered as benign) and track scanning ourselves
    const [scanning, setScanning] = createState(false)

    // scan while this pane is visible (hiding QSettings resets the pane to
    // "main", so discovery always stops on close)
    const maybeScan = () => {
        if (pane.get() === name && adapter.powered) {
            startDiscoveryAsync()
            setScanning(true)
        } else {
            stopDiscoveryAsync()
            setScanning(false)
        }
    }
    pane.subscribe(maybeScan)
    createBinding(adapter, "powered").subscribe(maybeScan)
    maybeScan()

    // the pairing prompt renders inline while this pane is on screen;
    // the floating dialog window covers prompts arriving otherwise
    const updatePaneOpen = () => setBtPaneOpen(pane.get() === name)
    pane.subscribe(updatePaneOpen)
    updatePaneOpen()

    // mirror the device list into state, and bump it when any device's
    // paired/connected/name flag flips — the devices binding alone only
    // fires on add/remove. Updates are coalesced: bluez removes quiet
    // temporary devices and re-adds them on the next advertisement, and
    // mirroring every flap resizes the pane ("keeps expanding/shrinking")
    const [deviceList, setDeviceList] =
        createState<AstalBluetooth.Device[]>(bluetooth.devices)
    let listTimer = 0
    const refreshDeviceList = () => {
        if (listTimer) return
        listTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            listTimer = 0
            setDeviceList([...bluetooth.devices])
            return GLib.SOURCE_REMOVE
        })
    }
    const hookedDevices = new Map<string, { d: AstalBluetooth.Device, ids: number[] }>()
    function hookDevice(d: AstalBluetooth.Device) {
        const existing = hookedDevices.get(d.address)
        if (existing?.d === d) return
        // bluez can recreate the device object for the same address:
        // drop the handlers on the stale object before re-hooking
        if (existing) for (const id of existing.ids) existing.d.disconnect(id)
        hookedDevices.set(d.address, { d, ids: [
            d.connect("notify::paired", refreshDeviceList),
            d.connect("notify::connected", refreshDeviceList),
            // devices are often discovered unnamed; when the name resolves a
            // moment later (property change, no list change) they must enter
            // the available list then, not never
            d.connect("notify::name", refreshDeviceList),
            d.connect("notify::alias", refreshDeviceList),
        ]})
    }
    function pruneDevices() {
        const live = new Set(bluetooth.devices.map(d => d.address))
        for (const [addr, h] of hookedDevices) {
            if (live.has(addr)) continue
            for (const id of h.ids) h.d.disconnect(id)
            hookedDevices.delete(addr)
        }
    }
    createBinding(bluetooth, "devices").subscribe(() => {
        bluetooth.devices.forEach(hookDevice)
        pruneDevices()
        refreshDeviceList()
    })
    bluetooth.devices.forEach(hookDevice)

    const paired = deviceList.as(ds => [...ds]
        // paired only: bluez marks a device paired as soon as it is
        // connected, and a failed connect attempt on an unpaired device
        // must not bounce the row between sections
        .filter(d => d.paired)
        .sort((a, b) => Number(b.connected) - Number(a.connected)
            || (a.alias || a.name).localeCompare(b.alias || b.name)))
    const available = deviceList.as(ds => [...ds]
        // not paired: bluez sets connected during pairing, before paired
        // flips — filtering on !connected too would make the device
        // briefly vanish from both sections mid-pairing
        .filter(d => !d.paired && d.name)
        .sort((a, b) => b.rssi - a.rssi)
        .slice(0, 8))

    const powered = createBinding(adapter, "powered")


    function DeviceRow({ device }: { device: AstalBluetooth.Device }) {
        const [pending, setPending] =
            createState<"" | "pairing" | "connecting" | "disconnecting">("")
        const [error, setError] = createState("")
        const [detailsOpen, setDetailsOpen] = createState(false)
        let errorToken = 0
        let pairAttempt = 0

        function fail(msg: string, e: unknown) {
            console.warn(`bluetooth: ${msg}:`, e)
            setPending("")
            setError(msg)
            const token = ++errorToken
            setTimeout(() => { if (token === errorToken) setError("") }, 4000)
        }

        const status = createComputed(
            [pending, error, createBinding(device, "connecting"),
                createBinding(device, "connected"), createBinding(device, "paired"),
                createBinding(device, "batteryPercentage")],
            (pending, error, connecting, connected, paired, battery) => {
                if (error) return error
                if (pending === "pairing") return "Pairing…"
                if (pending === "connecting" || connecting) return "Connecting…"
                if (pending === "disconnecting") return "Disconnecting…"
                if (connected) return battery >= 0 ? `Connected · ${battery}%` : "Connected"
                return paired ? "Paired" : "Available"
            })
        const statusClass = error.as(e => e ? ["status", "error"] : ["status"])
        const isPaired = createBinding(device, "paired")

        // bluez pairing/connecting is slow and flaky while a scan is
        // active: pause discovery for the duration, resume after
        function pauseDiscovery() {
            stopDiscoveryAsync()
            setScanning(false)
        }

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
                let handlerId = device.connect("notify::paired", () => {
                    if (!device.paired) return
                    device.disconnect(handlerId)
                    handlerId = 0
                    setPending("connecting")
                    connectDevice()
                })
                setTimeout(() => {
                    if (attempt !== pairAttempt) return
                    if (handlerId) {
                        device.disconnect(handlerId)
                        handlerId = 0
                    }
                    if (pending.get() === "pairing") {
                        fail("Pairing failed", "timed out")
                        dismissPairingPrompt(device.address)
                        maybeScan()
                    }
                }, 30_000)
                pairDeviceAsync(device).catch(e => {
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
            uuids.length
                ? [...new Set(uuids.map(uuidName))].join(", ")
                : "—")

        return <box orientation={Gtk.Orientation.VERTICAL}>
            <box
                cssName={"button"}
                cssClasses={createBinding(device, "connected")
                    .as(c => c ? ["btDevice", "active"] : ["btDevice"])}
                spacing={5}
                tooltipText={createComputed(
                    [createBinding(device, "connected"),
                        createBinding(device, "batteryPercentage")],
                    (c, b) => c && b >= 0
                        ? `${device.address} · ${b}%`
                        : device.address)}
            >
                {/* gesture only on the info area: nested buttons must not
                    re-trigger the row click (see notification center) */}
                <box spacing={5} hexpand>
                    <Gtk.GestureClick button={1} onPressed={onClick} />
                    <image
                        iconName={createBinding(device, "icon")
                            .as(i => i || "bluetooth-symbolic")}
                        valign={Gtk.Align.START}
                    />
                    <box orientation={Gtk.Orientation.VERTICAL} hexpand>
                        <label
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
                    <image iconName={detailsOpen.as(o => o
                        ? "pan-up-symbolic"
                        : "dialog-information-symbolic")} />
                </button>
                <button
                    cssClasses={createBinding(device, "trusted")
                        .as(t => t ? ["trust", "active"] : ["trust"])}
                    visible={isPaired}
                    tooltipText={"Trusted"}
                    onClicked={() => { device.trusted = !device.trusted }}
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
                    {details.map(([key, value]) =>
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
                    )}
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
                    {wp?.audio && <With value={createBinding(wp.audio, "devices").as(ds => {
                        const wanted = (device.alias || device.name).toLowerCase()
                        return (ds ?? []).find(d =>
                            d.icon?.includes("bluetooth") &&
                            d.description?.toLowerCase() === wanted) ?? null
                    })}>
                        {(wpDev) => wpDev && <ProfileSelector wpDev={wpDev} />}
                    </With>}
                </box>
            </revealer>
        </box>
    }

    return <box orientation={Gtk.Orientation.VERTICAL}>
        {/* pairing prompt replaces the pane content while pending:
            pairing is modal, nothing else should be clickable */}
        <With value={pairingRequest}>
            {(req) => req && <PromptContent req={req} />}
        </With>
        <box
            orientation={Gtk.Orientation.VERTICAL}
            visible={pairingRequest.as(r => r === null)}
        >
        <box
            cssName={"button"}
            spacing={5}
            visible={powered.as(p => !p)}
        >
            <Gtk.GestureClick button={1} onPressed={() => { adapter.powered = true }} />
            <image iconName="bluetooth-disabled-symbolic" />
            <label label={"Bluetooth is off — Turn on"} hexpand xalign={0} />
        </box>
        <box orientation={Gtk.Orientation.VERTICAL} visible={powered}>
            {/* each section in its own container: For re-appends its
                children at the end of the parent on every update, which
                would scramble static siblings */}
            <box orientation={Gtk.Orientation.VERTICAL} visible={paired.as(l => l.length > 0)}>
                <label label={"Paired"} cssClasses={["btSection"]} xalign={0} />
                <For each={paired}>
                    {(device) => <DeviceRow device={device} />}
                </For>
            </box>
            <box orientation={Gtk.Orientation.VERTICAL}>
                <box>
                    <label label={"Available"} cssClasses={["btSection"]} xalign={0} hexpand />
                    <Gtk.Spinner
                        $={(self) => self.start()}
                        visible={scanning}
                    />
                    <button
                        cssClasses={["rescan"]}
                        tooltipText={"Scan again"}
                        onClicked={rescan}
                    >
                        <image
                            iconName={rescanning.as(r => r
                                ? "content-loading-symbolic"
                                : "view-refresh-symbolic")}
                        />
                    </button>
                </box>
                <For each={available}>
                    {(device) => <DeviceRow device={device} />}
                </For>
                <box
                    cssName={"button"}
                    spacing={8}
                    visible={available.as(l => l.length === 0)}
                >
                    <Gtk.GestureClick button={1} onPressed={rescan} />
                    {/* real spinner while scanning: the loading icon
                        renders as an ugly "•••" glyph */}
                    <Gtk.Spinner
                        $={(self) => self.start()}
                        visible={scanning}
                    />
                    <image
                        iconName="bluetooth-symbolic"
                        visible={scanning.as(s => !s)}
                    />
                    <label
                        label={scanning.as(d => d
                            ? "Scanning…"
                            : "No devices found — scan again")}
                        hexpand
                        xalign={0}
                    />
                </box>
            </box>
            <box
                cssName={"button"}
                spacing={5}
                cssClasses={createBinding(adapter, "discoverable")
                    .as(d => d ? ["active"] : [""])}
            >
                <Gtk.GestureClick
                    button={1}
                    onPressed={() => { adapter.discoverable = !adapter.discoverable }}
                />
                <label label={"Visible to other devices"} hexpand xalign={0} />
                <image
                    iconName={createBinding(adapter, "discoverable")
                        .as(d => d ? "object-select-symbolic" : "window-close-symbolic")}
                />
            </box>
        </box>
        </box>
    </box>
}
