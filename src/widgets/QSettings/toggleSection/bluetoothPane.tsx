import { Accessor, createBinding, createState, For, onCleanup, With } from "gnim"
import { PaneEmpty } from "../../PaneEmpty"
import AstalBluetooth from "gi://AstalBluetooth?version=0.1"
import GLib from "gi://GLib?version=2.0"
import { Gtk } from "ags/gtk4"
import bluetooth from "../../../lib/bluetooth"
import { timeoutAdd, sourceRemove, connect, disconnect } from "../../../lib/metrics"
import { pairingRequest, setBtPaneOpen } from "../../../lib/bluetoothAgent"
import { PromptContent } from "../../bluetoothPairing"
import { startDiscoveryAsync, stopDiscoveryAsync, cancelDiscoveryRetry } from "./bluez"
import { DeviceRow } from "./bluetoothDeviceRow"
import { createDelayer } from "../../delay"

interface btPaneProps {
    /** current pane name, discovery runs while this pane is visible */
    pane: Accessor<string>
    name: string
}

export function BluetoothWidget({ pane, name }: btPaneProps) {
    // same hotplug rebind as the toggle button (bluetooth.tsx)
    return (
        <With value={createBinding(bluetooth, "adapter")}>
            {adapter => (adapter ? <BluetoothWidgetBody pane={pane} name={name} /> : <></>)}
        </With>
    )
}

/** the on/off switch in the bluetooth pane's header row */
export function BtSwitch() {
    return (
        <With value={createBinding(bluetooth, "adapter")}>
            {adapter =>
                adapter && (
                    <Gtk.Switch
                        cssClasses={["paneSwitch"]}
                        valign={Gtk.Align.CENTER}
                        active={createBinding(adapter, "powered")}
                        onNotifyActive={self => {
                            if (self.active !== adapter.powered) adapter.powered = self.active
                        }}
                    />
                )
            }
        </With>
    )
}

function BluetoothWidgetBody({ pane, name }: btPaneProps) {
    // tracked and cancelled on teardown (see widgets/delay.ts)
    const delay = createDelayer("bluetoothPane")
    // non-null: the wrapper only mounts this body with an adapter
    const adapter = bluetooth.adapter!

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
        delay(3000, () => {
            if (token === rescanToken) setRescanning(false)
        })
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

    // bluez pairing/connecting is slow and flaky while a scan is
    // active: pause discovery for the duration, resume after
    function pauseDiscovery() {
        stopDiscoveryAsync()
        setScanning(false)
    }

    // everything below must die with this body: it remounts whenever
    // the adapter flips (rfkill, dongle, bluez restart), and these
    // subscribe on the long-lived pane accessor, the old adapter
    // proxy, and every device object
    const disposers: (() => void)[] = []
    onCleanup(() => {
        for (const d of disposers) d()
        for (const h of hookedDevices.values()) for (const id of h.ids) disconnect(h.d, id)
        hookedDevices.clear()
        if (listTimer) {
            sourceRemove(listTimer)
            listTimer = 0
        }
        // a NotReady retry armed while the pane was open must not start
        // discovery with it closed
        cancelDiscoveryRetry()
        setBtPaneOpen(false)
        stopDiscoveryAsync()
    })

    disposers.push(pane.subscribe(maybeScan))
    disposers.push(createBinding(adapter, "powered").subscribe(maybeScan))
    maybeScan()

    // the pairing prompt renders inline while this pane is on screen;
    // the floating dialog window covers prompts arriving otherwise
    const updatePaneOpen = () => setBtPaneOpen(pane.get() === name)
    disposers.push(pane.subscribe(updatePaneOpen))
    updatePaneOpen()

    // mirror the device list into state, and bump it when any device's
    // paired/connected/name flag flips — the devices binding alone only
    // fires on add/remove. Updates are coalesced: bluez removes quiet
    // temporary devices and re-adds them on the next advertisement, and
    // mirroring every flap resizes the pane ("keeps expanding/shrinking")
    const [deviceList, setDeviceList] = createState<AstalBluetooth.Device[]>(bluetooth.devices)
    let listTimer = 0
    const refreshDeviceList = () => {
        if (listTimer) return
        listTimer = timeoutAdd("btPane:deviceListCoalesce", GLib.PRIORITY_DEFAULT, 400, () => {
            listTimer = 0
            setDeviceList([...bluetooth.devices])
            return GLib.SOURCE_REMOVE
        })
    }
    const hookedDevices = new Map<string, { d: AstalBluetooth.Device; ids: number[] }>()
    function hookDevice(d: AstalBluetooth.Device) {
        const existing = hookedDevices.get(d.address)
        if (existing?.d === d) return
        // bluez can recreate the device object for the same address:
        // drop the handlers on the stale object before re-hooking
        if (existing) for (const id of existing.ids) disconnect(existing.d, id)
        hookedDevices.set(d.address, {
            d,
            ids: [
                connect(d, "notify::paired", refreshDeviceList),
                connect(d, "notify::connected", refreshDeviceList),
                // devices are often discovered unnamed; when the name resolves a
                // moment later (property change, no list change) they must enter
                // the available list then, not never
                connect(d, "notify::name", refreshDeviceList),
                connect(d, "notify::alias", refreshDeviceList),
            ],
        })
    }
    function pruneDevices() {
        const live = new Set(bluetooth.devices.map(d => d.address))
        for (const [addr, h] of hookedDevices) {
            if (live.has(addr)) continue
            for (const id of h.ids) disconnect(h.d, id)
            hookedDevices.delete(addr)
        }
    }
    disposers.push(
        createBinding(bluetooth, "devices").subscribe(() => {
            bluetooth.devices.forEach(hookDevice)
            pruneDevices()
            refreshDeviceList()
        }),
    )
    bluetooth.devices.forEach(hookDevice)

    const paired = deviceList.as(ds =>
        [...ds]
            // paired only: bluez marks a device paired as soon as it is
            // connected, and a failed connect attempt on an unpaired device
            // must not bounce the row between sections
            .filter(d => d.paired)
            .sort(
                (a, b) =>
                    Number(b.connected) - Number(a.connected) ||
                    (a.alias || a.name).localeCompare(b.alias || b.name),
            ),
    )
    const available = deviceList.as(ds =>
        [...ds]
            // not paired: bluez sets connected during pairing, before paired
            // flips — filtering on !connected too would make the device
            // briefly vanish from both sections mid-pairing
            .filter(d => !d.paired && d.name)
            .sort((a, b) => b.rssi - a.rssi)
            .slice(0, 8),
    )

    const powered = createBinding(adapter, "powered")

    return (
        <box orientation={Gtk.Orientation.VERTICAL}>
            {/* pairing prompt replaces the pane content while pending:
            pairing is modal, nothing else should be clickable */}
            <With value={pairingRequest}>{req => req && <PromptContent req={req} />}</With>
            <box
                orientation={Gtk.Orientation.VERTICAL}
                visible={pairingRequest.as(r => r === null)}
            >
                <box visible={powered.as(p => !p)}>
                    {/* fills the middle instead of a bare row: the pane
                    keeps the shell's consistent size */}
                    <PaneEmpty
                        icon="bluetooth-disabled-symbolic"
                        title={"Bluetooth is off"}
                        hint={"Click to turn on"}
                        onClick={() => {
                            adapter.powered = true
                        }}
                    />
                </box>
                <box orientation={Gtk.Orientation.VERTICAL} visible={powered}>
                    {/* each section in its own container: For re-appends its
                children at the end of the parent on every update, which
                would scramble static siblings */}
                    <box
                        orientation={Gtk.Orientation.VERTICAL}
                        visible={paired.as(l => l.length > 0)}
                    >
                        <label label={"Paired"} cssClasses={["paneSection"]} xalign={0} hexpand />
                        <box
                            orientation={Gtk.Orientation.VERTICAL}
                            cssClasses={["paneCard"]}
                            spacing={2}
                        >
                            <For each={paired}>
                                {device => (
                                    <DeviceRow
                                        device={device}
                                        pauseDiscovery={pauseDiscovery}
                                        maybeScan={maybeScan}
                                    />
                                )}
                            </For>
                        </box>
                    </box>
                    <box orientation={Gtk.Orientation.VERTICAL}>
                        <box>
                            <label
                                label={"Available"}
                                cssClasses={["paneSection"]}
                                xalign={0}
                                hexpand
                            />
                            <Gtk.Spinner $={self => self.start()} visible={scanning} />
                            <button
                                cssClasses={["rescan"]}
                                tooltipText={"Scan again"}
                                onClicked={rescan}
                            >
                                <image
                                    iconName={rescanning.as(r =>
                                        r ? "content-loading-symbolic" : "view-refresh-symbolic",
                                    )}
                                />
                            </button>
                        </box>
                        <box
                            orientation={Gtk.Orientation.VERTICAL}
                            cssClasses={["paneCard"]}
                            spacing={2}
                            visible={available.as(l => l.length > 0)}
                        >
                            <For each={available}>
                                {device => (
                                    <DeviceRow
                                        device={device}
                                        pauseDiscovery={pauseDiscovery}
                                        maybeScan={maybeScan}
                                    />
                                )}
                            </For>
                        </box>
                        {/* centered empty state (click = scan again).
                        While a scan is in flight say so: "No devices
                        found" would be a verdict the scan hasn't
                        reached yet */}
                        <box visible={available.as(l => l.length === 0)}>
                            <PaneEmpty
                                icon="bluetooth-symbolic"
                                title={scanning.as(s => (s ? "Scanning…" : "No devices found"))}
                                hint={scanning.as(s => (s ? "" : "Click to scan again"))}
                                onClick={rescan}
                            />
                        </box>
                    </box>
                    {/* anchored to the pane's bottom: the lists above
                    grow/shrink, this stays put */}
                    <box cssClasses={["paneCard"]} valign={Gtk.Align.END} vexpand>
                        <box
                            cssName={"button"}
                            spacing={5}
                            cssClasses={createBinding(adapter, "discoverable").as(d =>
                                d ? ["paneRow", "active"] : ["paneRow"],
                            )}
                        >
                            <Gtk.GestureClick
                                button={1}
                                onPressed={() => {
                                    adapter.discoverable = !adapter.discoverable
                                }}
                            />
                            <label label={"Visible to other devices"} hexpand xalign={0} />
                            {/* display-only checkbox: the row's gesture
                            toggles; keeps it single-action */}
                            <Gtk.CheckButton
                                cssClasses={["paneCheckbox"]}
                                valign={Gtk.Align.CENTER}
                                sensitive={false}
                                active={createBinding(adapter, "discoverable")}
                            />
                        </box>
                    </box>
                </box>
            </box>
        </box>
    )
}
