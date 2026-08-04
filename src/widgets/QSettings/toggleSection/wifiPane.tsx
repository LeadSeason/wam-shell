import { Accessor, createBinding, createComputed, createState, For, onCleanup, With } from "gnim"
import { PaneEmpty } from "../../PaneEmpty"
import { OverlayIcon, bandBadgeOf } from "./ToggleButton"
import AstalNetwork from "gi://AstalNetwork?version=0.1"
import NM from "gi://NM?version=1.0"
import GLib from "gi://GLib?version=2.0"
import { execAsync, timeoutAdd, sourceRemove } from "../../../lib/metrics"
import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango?version=1.0"
import { known } from "./savedNetworks"
import { securityOf, bandOf, channelOf, ApRow, PasswordPrompt, WifiPrompt } from "./wifiApRow"

interface wifiPaneProps {
    /** current pane name, rescans when this pane becomes visible */
    pane: Accessor<string>
    name: string
}

/** the on/off switch that sits in the wifi pane's header row */
export function WifiSwitch() {
    // rebind like the toggle: the switch must not drive a dead adapter
    return (
        <With value={createBinding(AstalNetwork.get_default(), "wifi")}>
            {wifi =>
                wifi && (
                    <Gtk.Switch
                        cssClasses={["paneSwitch"]}
                        valign={Gtk.Align.CENTER}
                        active={createBinding(wifi, "enabled")}
                        onNotifyActive={self => wifi.set_enabled(self.active)}
                    />
                )
            }
        </With>
    )
}

/** the connected-network card: ssid, band+channel+security, ips, mac
 *  and negotiated link speed; a status line when off or unassociated */
function DeviceDetails({ dev }: { dev: NM.DeviceWifi }) {
    const ipLine = createComputed(
        [createBinding(dev, "ip4Config"), createBinding(dev, "ip6Config")],
        () => {
            const v4 = dev.get_ip4_config()?.get_addresses()?.[0]?.get_address()
            const v6addrs = dev.get_ip6_config()?.get_addresses()
            const v6 = v6addrs && v6addrs.length > 0 ? v6addrs[0].get_address() : null
            return [v4, v6].filter(Boolean).join(" · ")
        },
    )
    const hwLine = createBinding(dev, "bitrate").as(() => {
        const mac = dev.get_permanent_hw_address() ?? dev.get_hw_address() ?? ""
        const bitrate = dev.get_bitrate()
        const speed = bitrate > 0 ? `${Math.round(bitrate / 1000)} Mb/s` : ""
        return [mac && `MAC ${mac}`, speed].filter(Boolean).join(" · ")
    })
    return (
        <box orientation={Gtk.Orientation.VERTICAL}>
            <label
                cssClasses={["wifiConnectedInfo"]}
                xalign={0}
                label={ipLine}
                visible={ipLine.as(l => l !== "")}
            />
            <label
                cssClasses={["wifiConnectedInfo"]}
                xalign={0}
                label={hwLine}
                visible={hwLine.as(l => l !== "")}
            />
        </box>
    )
}

function ConnectedSection({ wifi }: { wifi: AstalNetwork.Wifi }) {
    const enabled = createBinding(wifi, "enabled")
    const ssid = createBinding(wifi, "ssid")
    const activeAp = createBinding(wifi, "activeAccessPoint")

    const connected = createComputed([enabled, ssid], (e, s) => e && !!s)
    const status = createComputed([enabled, ssid], (e, s) => (e && !s ? "On — not connected" : ""))

    return (
        // hidden entirely when wifi is off — the header switch says it
        <box orientation={Gtk.Orientation.VERTICAL} visible={enabled}>
            <label label={"Connected network"} cssClasses={["paneSection"]} xalign={0} hexpand />
            <box orientation={Gtk.Orientation.VERTICAL} visible={connected}>
                <box cssClasses={["wifiConnected"]} spacing={10}>
                    <OverlayIcon
                        icon={createBinding(wifi, "iconName")}
                        badge={activeAp.as(ap => (ap ? bandBadgeOf(ap.frequency) : ""))}
                    />
                    <box orientation={Gtk.Orientation.VERTICAL} hexpand>
                        <label
                            cssClasses={["wifiConnectedSsid"]}
                            label={ssid.as(f => {
                                return f ? f : "-"
                            })}
                            xalign={0}
                            maxWidthChars={24}
                            ellipsize={Pango.EllipsizeMode.END}
                        />
                        <label
                            cssClasses={["wifiConnectedInfo"]}
                            xalign={0}
                            label={activeAp.as(ap =>
                                ap
                                    ? `${bandOf(ap)} · ch ${Math.round(channelOf(ap.frequency))} · ${securityOf(ap)}`
                                    : "",
                            )}
                        />
                        {/* rebind on notify::device: the NM device can
                        appear after the wifi object, or be swapped on
                        multi-adapter machines */}
                        <With value={createBinding(wifi, "device")}>
                            {dev => dev && <DeviceDetails dev={dev as NM.DeviceWifi} />}
                        </With>
                    </box>
                </box>
            </box>
            <label
                cssClasses={["wifiStatus"]}
                label={status}
                xalign={0}
                visible={connected.as(c => !c)}
            />
        </box>
    )
}

export function WifiWidget({ pane, name }: wifiPaneProps) {
    // same rebind as the toggle: a removed adapter empties the pane
    // (the header stays) instead of showing stale details
    return (
        <With value={createBinding(AstalNetwork.get_default(), "wifi")}>
            {wifi => wifi && <WifiPane wifi={wifi} pane={pane} name={name} />}
        </With>
    )
}

function WifiPane({ wifi, pane, name }: { wifi: AstalNetwork.Wifi } & wifiPaneProps) {
    // scan whenever this pane becomes visible — same pulse feedback as
    // the rescan button so the refresh is visible
    // (subscribe callbacks receive no value, read it).
    // the widget remounts on adapter removal/swap: drop the old
    // subscription or it stacks on the long-lived pane accessor
    const disposers = [
        pane.subscribe(() => {
            if (pane.get() === name) rescan()
            else setPrompt(null) // drop a stale prompt when leaving the pane
        }),
    ]
    onCleanup(() => {
        for (const d of disposers) d()
        stopSpin()
    })

    // rescan pulse feedback: the button disables and the icon spins.
    // gtk css has no keyframe animations, so a ticker steps a rotate
    // transform while the scan is in flight
    const [rescanning, setRescanning] = createState(false)
    const [spin, setSpin] = createState(0)
    let rescanToken = 0
    let spinSource: number | null = null
    function stopSpin() {
        if (spinSource !== null) {
            sourceRemove(spinSource)
            spinSource = null
        }
        setSpin(0)
    }
    function rescan() {
        // scanning while the radio is off throws in astal-network
        // ("Scanning not allowed while unavailable")
        if (wifi.enabled) wifi.scan()
        setRescanning(true)
        if (spinSource !== null) sourceRemove(spinSource)
        spinSource = timeoutAdd("wifi:rescan-spin", GLib.PRIORITY_DEFAULT, 100, () => {
            setSpin((spin.get() + 30) % 360)
            return GLib.SOURCE_CONTINUE
        })
        const token = ++rescanToken
        setTimeout(() => {
            if (token === rescanToken) {
                setRescanning(false)
                stopSpin()
            }
        }, 3000)
    }

    const [prompt, setPrompt] = createState<WifiPrompt | null>(null)

    // bssid of the AP currently being connected, null when idle —
    // pane-wide mutual exclusion for connection attempts
    const [connectingBssid, setConnectingBssid] = createState<string | null>(null)

    const accessPoints = createBinding(wifi, "accessPoints").as(aps =>
        [...aps].filter(ap => ap.ssid),
    )

    function iface(): string | null {
        return wifi.device?.get_iface() ?? null
    }

    function disconnect() {
        const dev = iface()
        if (dev)
            execAsync(["nmcli", "device", "disconnect", dev]).catch(e =>
                console.warn("wifi disconnect failed:", e),
            )
    }

    // flat per-AP list: no SSID merging and no band sections — each
    // access point is its own row, the band shows as the icon badge.
    // known first, then by strength
    const sortedAps = accessPoints.as(aps =>
        [...aps]
            .sort((a, b) => Number(known(b)) - Number(known(a)) || b.strength - a.strength)
            .slice(0, 12),
    )

    return (
        <box orientation={Gtk.Orientation.VERTICAL}>
            <With value={prompt}>
                {p =>
                    p && (
                        <PasswordPrompt
                            p={p}
                            connectingBssid={connectingBssid}
                            setConnectingBssid={setConnectingBssid}
                            setPrompt={setPrompt}
                        />
                    )
                }
            </With>
            <box orientation={Gtk.Orientation.VERTICAL} visible={prompt.as(p => p === null)}>
                <ConnectedSection wifi={wifi} />
                <Gtk.Separator visible={createBinding(wifi, "enabled")} />
                {/* empty states: radio off, and radio on with no
                networks in range — the pane keeps the shell's size and
                fills the middle instead of shrinking */}
                <box visible={createBinding(wifi, "enabled").as(e => !e)}>
                    <PaneEmpty
                        icon="network-wireless-disabled-symbolic"
                        title={"Wi-Fi is off"}
                        hint={"Flip the switch above to turn it on"}
                    />
                </box>
                <box
                    orientation={Gtk.Orientation.VERTICAL}
                    visible={createBinding(wifi, "enabled")}
                >
                    <box>
                        <label label={"Networks"} cssClasses={["paneSection"]} xalign={0} hexpand />
                        <button
                            cssClasses={["rescan"]}
                            tooltipText={"Scan again"}
                            // always visible; disabled and spinning mid-scan
                            sensitive={rescanning.as(r => !r)}
                            onClicked={rescan}
                        >
                            <image
                                iconName="view-refresh-symbolic"
                                css={spin.as(deg => (deg ? `transform: rotate(${deg}deg);` : ""))}
                            />
                        </button>
                    </box>
                    {/* radio on with no networks in range: fill the
                    middle instead of shrinking the pane. While a scan
                    is in flight say so — "No networks found" would be
                    a verdict the scan hasn't reached yet */}
                    <box visible={sortedAps.as(aps => aps.length === 0)}>
                        <PaneEmpty
                            icon="network-wireless-symbolic"
                            title={rescanning.as(r => (r ? "Scanning…" : "No networks found"))}
                            hint={rescanning.as(r => (r ? "" : "Try rescanning in a moment"))}
                        />
                    </box>
                    {/* For in its own container: it re-appends children at
                    the parent's end on every update, which would float
                    the join row above the networks */}
                    <box
                        orientation={Gtk.Orientation.VERTICAL}
                        cssClasses={["paneCard"]}
                        spacing={2}
                    >
                        <For each={sortedAps}>
                            {ap => (
                                <ApRow
                                    ap={ap}
                                    wifi={wifi}
                                    connectingBssid={connectingBssid}
                                    setConnectingBssid={setConnectingBssid}
                                    setPrompt={setPrompt}
                                    disconnect={disconnect}
                                />
                            )}
                        </For>
                    </box>
                    {/* anchored to the pane's bottom, like the
                    bluetooth pane's discoverable toggle */}
                    <box cssClasses={["paneCard"]} valign={Gtk.Align.END} vexpand>
                        <box cssName={"button"} cssClasses={["paneRow"]} spacing={5}>
                            <Gtk.GestureClick
                                button={1}
                                onPressed={() => setPrompt({ ssid: "", ap: null })}
                            />
                            <image iconName="list-add-symbolic" />
                            <label label={"Join hidden network…"} hexpand xalign={0} />
                        </box>
                    </box>
                </box>
            </box>
        </box>
    )
}
