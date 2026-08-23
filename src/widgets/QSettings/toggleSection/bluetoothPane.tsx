import { Accessor, createBinding, createState, For, onCleanup, With } from "gnim"
import { PaneEmpty } from "../../PaneEmpty"
import AstalBluetooth from "gi://AstalBluetooth?version=0.1"
import GLib from "gi://GLib?version=2.0"
import { Gtk } from "ags/gtk4"
import bluetooth from "../../../lib/bluetooth"
import { timeoutAdd, sourceRemove, connect, disconnect } from "../../../lib/metrics"
import { pairingRequest, setBtPaneOpen } from "../../../lib/bluetoothAgent"
import { PromptContent } from "../../bluetoothPairing"
import {
    startDiscoveryAsync,
    stopDiscoveryAsync,
    cancelDiscoveryRetry,
    setPoweredAsync,
    powerPending,
} from "../../../lib/bluetoothCtl"
import { acquireRange, advertises, sightings } from "../../../lib/bluetoothRange"
import { DeviceRow } from "./bluetoothDeviceRow"
import { createDelayer } from "../../delay"

interface btPaneProps {
    /** current pane name, discovery runs while this pane is visible */
    pane: Accessor<string>
    name: string
}

export function BluetoothWidget({ pane, name }: btPaneProps) {
    // same hotplug rebind as the toggle button (bluetooth.tsx). It
    // covers an adapter APPEARING, not one being replaced: notify::adapter
    // does not fire for the swap (see BluetoothWidgetBody)
    return (
        <With value={createBinding(bluetooth, "adapter")}>
            {/* null, not <></>: With appends the child into its own
            Fragment, and nested Fragments are unsupported. This branch is
            only reached on a machine with no adapter at all, which is why
            it sat here unnoticed */}
            {adapter => (adapter ? <BluetoothWidgetBody pane={pane} name={name} /> : null)}
        </With>
    )
}

/** the on/off switch in the bluetooth pane's header row */
export function BtSwitch() {
    return (
        <With value={createBinding(bluetooth, "adapter")}>
            {/* null, not <></>: With appends the child into its own
            Fragment, and nested Fragments are unsupported. The parameter
            is annotated because T does not flow from `value` through
            createBinding's overloads — without it the adapter arrives as
            `{}`, which is truthy, and the guard below never sees a
            missing adapter. */}
            {(adapter: AstalBluetooth.Adapter | null) => (adapter ? <BtSwitchBody /> : null)}
        </With>
    )
}

function BtSwitchBody() {
    // powering an adapter is not instant, and bluez rejects some
    // requests outright: while a change is in flight the switch shows
    // the TARGET and refuses further input, instead of springing back to
    // the old position — which read as a click the shell had ignored.
    // Imperative rather than a computed: powerPending starts null and an
    // initially-falsy dep can leave a computed stale (see AGENTS.md)
    // is_powered, never adapter.powered — see the note on the captured
    // adapter in BluetoothWidgetBody below
    const [shown, setShown] = createState(powerPending.get() ?? bluetooth.is_powered)
    const sync = () => setShown(powerPending.get() ?? bluetooth.is_powered)
    const disposers = [
        createBinding(bluetooth, "is_powered").subscribe(sync),
        powerPending.subscribe(sync),
    ]
    onCleanup(() => disposers.forEach(d => d()))
    sync()

    return (
        <Gtk.Switch
            cssClasses={["paneSwitch"]}
            valign={Gtk.Align.CENTER}
            active={shown}
            sensitive={powerPending.as(p => p === null)}
            onNotifyActive={self => {
                if (self.active !== bluetooth.is_powered) setPoweredAsync(self.active)
            }}
        />
    )
}

// a classic BR/EDR device (most speakers and headsets) never advertises;
// it only answers an inquiry, and a bluez inquiry cycle runs ~10s. Until
// one full cycle has passed, "not in range" would only mean "not found
// YET", so no such verdict is offered before this
const SCAN_SETTLE_MS = 13_000

function BluetoothWidgetBody({ pane, name }: btPaneProps) {
    // tracked and cancelled on teardown (see widgets/delay.ts)
    const delay = createDelayer("bluetoothPane")
    // Non-null: the wrapper only mounts this body with an adapter. But
    // holding it is not safe, and NOTHING about power may be read off
    // it: astal swaps the Adapter object when bluez drops and re-adds it
    // (a bluetoothd restart) WITHOUT emitting notify::adapter, so the
    // `With` above never re-fires, this body never remounts, and what it
    // captured here stops tracking. Measured in a shell up ~2.5h across
    // several bluetoothd restarts: bluetooth.is_powered read true while
    // adapter.powered on this reference read false, same process, same
    // instant — which left the pane showing "Bluetooth is off" over a
    // working adapter, and maybeScan below never starting a scan, until
    // the shell was restarted.
    //
    // bluetooth.is_powered is astal's own, maintained against the LIVE
    // adapter, and it is what the tile and the switch already use.
    //
    // `discoverable` at the bottom of the pane has no such counterpart
    // and is still read off this reference: after a bluetoothd restart
    // that checkbox can show the wrong position. Its writes still land —
    // the object PATH does not change, only astal's wrapper for it — so
    // one click corrects it.
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

    // the scan has covered a full inquiry cycle, so silence from a
    // device now means something. Sticky WITHIN a visit — a pause for a
    // connect attempt does not un-learn what the scan already heard —
    // but cleared when the pane closes, because the sightings are
    // dropped with it and the next visit has to earn the verdict again
    const [scanSettled, setScanSettled] = createState(false)
    let settleTimer = 0
    function cancelSettle() {
        if (settleTimer) {
            sourceRemove(settleTimer)
            settleTimer = 0
        }
    }
    function armSettle() {
        if (settleTimer || scanSettled.get()) return
        settleTimer = timeoutAdd("btPane:scanSettle", GLib.PRIORITY_DEFAULT, SCAN_SETTLE_MS, () => {
            settleTimer = 0
            // only a scan that ran the whole way counts. Clicking a
            // device early pauses discovery, and settling on the back of
            // two seconds of listening would call the whole room absent
            if (scanning.get()) setScanSettled(true)
            return GLib.SOURCE_REMOVE
        })
    }

    // Knowing which devices the adapter can actually hear costs three bus
    // subscriptions and a sweep timer, so it is held only while the pane
    // is ON SCREEN — not while this body merely exists. The QSettings
    // widget tree is built at startup and this body lives as long as the
    // shell does, so acquiring at construction left the sweep running for
    // the whole session over a pane nobody had opened (caught by the perf
    // gate as `timer btRange:sweep 0 -> 1`). See updatePaneOpen below.
    let releaseRange: (() => void) | null = null

    // scan while this pane is visible (hiding QSettings resets the pane to
    // "main", so discovery always stops on close)
    const maybeScan = () => {
        if (pane.get() === name && bluetooth.is_powered) {
            startDiscoveryAsync()
            setScanning(true)
            armSettle()
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
        // the interrupted scan does not count towards a verdict; the
        // next one starts its clock over (see armSettle)
        cancelSettle()
    }

    // everything below must die with this body: it remounts when an
    // adapter appears on a machine that had none, and these subscribe on
    // the long-lived pane accessor, on the shared bluetooth object, and
    // on every device object. (It does NOT remount when the adapter is
    // swapped — see the note above.)
    const disposers: (() => void)[] = []
    onCleanup(() => {
        for (const d of disposers) d()
        for (const h of hookedDevices.values()) for (const id of h.ids) disconnect(h.d, id)
        hookedDevices.clear()
        if (listTimer) {
            sourceRemove(listTimer)
            listTimer = 0
        }
        cancelSettle()
        releaseRange?.()
        releaseRange = null
        // a NotReady retry armed while the pane was open must not start
        // discovery with it closed
        cancelDiscoveryRetry()
        setBtPaneOpen(false)
        stopDiscoveryAsync()
    })

    disposers.push(pane.subscribe(maybeScan))
    disposers.push(createBinding(bluetooth, "is_powered").subscribe(maybeScan))
    maybeScan()

    // the pairing prompt renders inline while this pane is on screen;
    // the floating dialog window covers prompts arriving otherwise
    const updatePaneOpen = () => {
        const open = pane.get() === name
        setBtPaneOpen(open)
        if (open && !releaseRange) {
            releaseRange = acquireRange()
        } else if (!open && releaseRange) {
            releaseRange()
            releaseRange = null
            // the sightings went with it
            cancelSettle()
            setScanSettled(false)
        }
    }
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

    // Both lists are sorted from a SNAPSHOT of what the adapter can
    // hear, taken whenever the device list itself changes. Re-sorting on
    // every RSSI update instead would reshuffle the rows several times a
    // second under the cursor — the readings arrive with every
    // advertisement. The per-row "Not in range" label does track live;
    // only the ORDER is held still.
    const [paired, setPaired] = createState<AstalBluetooth.Device[]>([])
    const [available, setAvailable] = createState<AstalBluetooth.Device[]>([])
    const resort = () => {
        const ds = deviceList.get()
        const heard = sightings.get()
        const rssiOf = (d: AstalBluetooth.Device) => heard.get(d.address)?.rssi ?? -Infinity
        // a device we have never heard advertise is not demoted: we have
        // no evidence it is anywhere, so ranking it below one we can see
        // would state something we do not know (see bluetoothRange)
        const inRange = (d: AstalBluetooth.Device) =>
            d.connected || heard.has(d.address) || !advertises(d.address)
        setPaired(
            [...ds]
                // paired only: bluez marks a device paired as soon as it is
                // connected, and a failed connect attempt on an unpaired device
                // must not bounce the row between sections
                .filter(d => d.paired)
                // connected first, then what is actually here, then the
                // rest — a device that is not in the room is the least
                // useful row on screen
                .sort(
                    (a, b) =>
                        Number(b.connected) - Number(a.connected) ||
                        Number(inRange(b)) - Number(inRange(a)) ||
                        (a.alias || a.name).localeCompare(b.alias || b.name),
                ),
        )
        setAvailable(
            [...ds]
                // not paired: bluez sets connected during pairing, before paired
                // flips — filtering on !connected too would make the device
                // briefly vanish from both sections mid-pairing
                .filter(d => !d.paired && d.name)
                // strongest first, and the slice below therefore keeps
                // the eight CLOSEST. It used to sort on astal's
                // Device.rssi, which is always 0, so the cut kept an
                // arbitrary eight and the device in your hand could be
                // one of the ones dropped
                .sort((a, b) => rssiOf(b) - rssiOf(a))
                .slice(0, 8),
        )
    }
    disposers.push(deviceList.subscribe(resort))
    // one clean re-sort when the scan's verdict lands
    disposers.push(scanSettled.subscribe(resort))
    resort()

    const powered = createBinding(bluetooth, "is_powered")

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
                        onClick={() => setPoweredAsync(true)}
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
                                        scanSettled={scanSettled}
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
                                        scanSettled={scanSettled}
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
