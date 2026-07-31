import { Accessor, createBinding, createComputed, createState, For, With } from "gnim"
import { DropdownButton, OverlayIcon, bandBadgeOf } from "./ToggleButton"
import AstalNetwork from "gi://AstalNetwork?version=0.1"
import NM from "gi://NM?version=1.0"
import { execAsync, connect } from "../../../lib/metrics"
import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango?version=1.0"

// NM.Client is also how we detect saved networks. ap.get_connections()
// (per-AP) CRASHES on stale/dropped access point objects (nm-access-point
// assertion + segfault) — never call methods on AP objects, read the
// client's connection list instead. Match by SSID, not profile name:
// they differ (NM appends a counter, e.g. "MyWiFi 1" for SSID "MyWiFi")
const nmClient = NM.Client.new(null)

const [savedNetworks, setSavedNetworks] = createState<Map<string, string>>(new Map())

function ssidOf(c: NM.RemoteConnection): string | null {
    const bytes = c.get_setting_wireless()?.get_ssid()
    if (!bytes) return null
    return new TextDecoder().decode(bytes.get_data() ?? new Uint8Array())
}

function refreshSaved() {
    const map = new Map<string, string>()
    for (const c of nmClient.get_connections()) {
        const ssid = ssidOf(c)
        if (ssid) map.set(ssid, c.get_id())
    }
    setSavedNetworks(map)
}
connect(nmClient, "connection-added", refreshSaved)
connect(nmClient, "connection-removed", refreshSaved)
refreshSaved()

interface wifiPaneProps {
    /** current pane name, rescans when this pane becomes visible */
    pane: Accessor<string>
    name: string
}

export function WifiButton({ navigate }: { navigate: () => void }) {
    const wifi = AstalNetwork.get_default().wifi
    // no wifi device on this machine
    if (!wifi) return <></>

    const subtitle = createComputed(
        [createBinding(wifi, "enabled"), createBinding(wifi, "ssid")],
        (enabled, ssid) => (enabled ? ssid || "On" : "Off"),
    )
    // band badge on the tile icon, only while associated
    const badge = createComputed(
        [createBinding(wifi, "enabled"), createBinding(wifi, "activeAccessPoint")],
        (enabled, ap) => (enabled && ap ? bandBadgeOf(ap.frequency) : ""),
    )

    return (
        <DropdownButton
            navigate={navigate}
            icon={createBinding(wifi, "iconName")}
            badge={badge}
            label={"Wi-Fi"}
            subtitle={subtitle}
            isActive={createBinding(wifi, "enabled")}
            activate={() => wifi.set_enabled(!wifi.enabled)}
        />
    )
}

// NM 80211ApSecurityFlags key-mgmt bits
const KEY_MGMT_PSK = 0x100
const KEY_MGMT_802_1X = 0x200
const KEY_MGMT_SAE = 0x400

function securityOf(ap: AstalNetwork.AccessPoint): string {
    if (ap.rsnFlags & KEY_MGMT_SAE) return "WPA3"
    if (ap.rsnFlags & KEY_MGMT_PSK) return "WPA2"
    if (ap.rsnFlags & KEY_MGMT_802_1X) return "Enterprise"
    if (ap.rsnFlags !== 0) return "WPA2"
    if (ap.wpaFlags !== 0) return "WPA"
    return "Open"
}

const secured = (ap: AstalNetwork.AccessPoint) => ap.rsnFlags !== 0 || ap.wpaFlags !== 0

function bandOf(ap: AstalNetwork.AccessPoint): string {
    if (ap.frequency >= 5925) return "6GHz"
    if (ap.frequency >= 5000) return "5GHz"
    return "2.4GHz"
}

function channelOf(freq: number): number {
    if (freq === 2484) return 14
    if (freq < 2484) return (freq - 2407) / 5
    if (freq < 5000) return (freq - 2510) / 5 + 15 // rough
    return (freq - 5000) / 5
}

/** the connected-network card: ssid, band+channel+security, ips, mac
 *  and negotiated link speed; a status line when off or unassociated */
function ConnectedSection({ wifi }: { wifi: AstalNetwork.Wifi }) {
    const enabled = createBinding(wifi, "enabled")
    const ssid = createBinding(wifi, "ssid")
    const activeAp = createBinding(wifi, "activeAccessPoint")

    const connected = createComputed([enabled, ssid], (e, s) => e && !!s)
    const status = createComputed([enabled, ssid], (e, s) =>
        !e ? "Wi-Fi is off" : "On — not connected",
    )

    const dev = wifi.device as NM.DeviceWifi | null
    const ipLine = dev
        ? createComputed([createBinding(dev, "ip4Config"), createBinding(dev, "ip6Config")], () => {
              const v4 = dev.get_ip4_config()?.get_addresses()?.[0]?.get_address()
              const v6addrs = dev.get_ip6_config()?.get_addresses()
              const v6 = v6addrs && v6addrs.length > 0 ? v6addrs[0].get_address() : null
              return [v4, v6].filter(Boolean).join(" · ")
          })
        : new Accessor(() => "")
    const hwLine = dev
        ? createBinding(dev, "bitrate").as(() => {
              const mac = dev.get_permanent_hw_address() ?? dev.get_hw_address() ?? ""
              const bitrate = dev.get_bitrate()
              const speed = bitrate > 0 ? `${Math.round(bitrate / 1000)} Mb/s` : ""
              return [mac && `MAC ${mac}`, speed].filter(Boolean).join(" · ")
          })
        : new Accessor(() => "")

    return (
        <box orientation={Gtk.Orientation.VERTICAL}>
            <label label={"Connected network"} cssClasses={["btSection"]} xalign={0} />
            <box orientation={Gtk.Orientation.VERTICAL} visible={connected}>
                <box cssClasses={["wifiConnected"]} spacing={10}>
                    <OverlayIcon
                        icon={createBinding(wifi, "iconName")}
                        badge={activeAp.as(ap => (ap ? bandBadgeOf(ap.frequency) : ""))}
                    />
                    <box orientation={Gtk.Orientation.VERTICAL} hexpand>
                        <label
                            cssClasses={["wifiConnectedSsid"]}
                            label={ssid}
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
    const wifi = AstalNetwork.get_default().wifi
    if (!wifi) return <></>

    // scan whenever this pane becomes visible — same pulse feedback as
    // the rescan button so the refresh is visible
    // (subscribe callbacks receive no value, read it)
    pane.subscribe(() => {
        if (pane.get() === name) rescan()
        else setPrompt(null) // drop a stale prompt when leaving the pane
    })

    // rescan pulse feedback, same as bluetooth
    const [rescanning, setRescanning] = createState(false)
    let rescanToken = 0
    function rescan() {
        wifi.scan()
        setRescanning(true)
        const token = ++rescanToken
        setTimeout(() => {
            if (token === rescanToken) setRescanning(false)
        }, 3000)
    }

    // password prompt: replaces the pane content while set
    interface Prompt {
        ssid: string
        ap: AstalNetwork.AccessPoint | null // null = hidden join
        /** row connect() so prompt-driven connects share pending/error */
        onConnect?: (password: string) => void
    }
    const [prompt, setPrompt] = createState<Prompt | null>(null)

    // bssid of the AP currently being connected, null when idle —
    // pane-wide mutual exclusion for connection attempts
    const [connectingBssid, setConnectingBssid] = createState<string | null>(null)

    const accessPoints = createBinding(wifi, "accessPoints").as(aps =>
        [...aps].filter(ap => ap.ssid),
    )

    const known = (ap: AstalNetwork.AccessPoint) => savedNetworks.get().has(ap.ssid)
    // nmcli needs the profile name, which may differ from the SSID
    const profileId = (ap: AstalNetwork.AccessPoint) => savedNetworks.get().get(ap.ssid) ?? ap.ssid

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

    function ApRow({ ap }: { ap: AstalNetwork.AccessPoint }) {
        const [error, setError] = createState("")
        const [detailsOpen, setDetailsOpen] = createState(false)
        const [autoconnect, setAutoconnect] = createState<boolean | null>(null)
        let errorToken = 0

        // one connection attempt at a time, pane-wide: while any AP is
        // connecting, all rows are blocked (busy) and only the in-flight
        // one shows "Connecting…"
        const pending = connectingBssid.as(b => b === ap.bssid)
        const busy = connectingBssid.as(b => b !== null)

        const active = createBinding(wifi, "activeAccessPoint").as(
            activeAp => activeAp?.bssid === ap.bssid,
        )
        const isKnown = savedNetworks.as(map => map.has(ap.ssid))

        function fail(msg: string, e: unknown) {
            console.warn(`wifi: ${msg}:`, e)
            setConnectingBssid(null)
            setError(msg)
            const token = ++errorToken
            setTimeout(() => {
                if (token === errorToken) setError("")
            }, 4000)
        }

        const status = createComputed(
            [active, pending, error, isKnown],
            (active, pending, error, known) => {
                if (error) return error
                if (pending) return "Connecting…"
                if (active) return "Connected"
                if (known) return `Known · ${ap.strength}%`
                return `${ap.strength}%`
            },
        )
        const statusClass = error.as(e => (e ? ["status", "error"] : ["status"]))

        function connect(password?: string) {
            // remember where we were: restore the previous network if
            // this attempt fails
            const previous = wifi.ssid || null
            setConnectingBssid(ap.bssid)
            let args: string[]
            if (password) {
                args = ["nmcli", "device", "wifi", "connect", ap.ssid, "password", password]
            } else if (isKnown.get()) {
                args = ["nmcli", "connection", "up", "id", profileId(ap)]
            } else {
                args = ["nmcli", "device", "wifi", "connect", ap.ssid]
            }
            const restore = () => {
                if (previous && previous !== ap.ssid) {
                    // profile names differ from SSIDs (NM appends a
                    // counter, e.g. "MyWiFi 1") — nmcli needs the profile name
                    const prevId = savedNetworks.get().get(previous) ?? previous
                    execAsync(["nmcli", "connection", "up", "id", prevId]).catch(e =>
                        console.warn("wifi restore failed:", e),
                    )
                }
            }
            // AstalNetwork.activate() fire-and-reports: it can return
            // success in ~30ms without the connection becoming active.
            // nmcli blocks until the connection is really up (or errors)
            execAsync(args)
                .then(() => setConnectingBssid(null))
                .catch(e => {
                    // known network with no stored secret: the activation
                    // fails immediately — ask for the password instead
                    if (!password && `${e}`.match(/secrets were required|password/i)) {
                        setConnectingBssid(null)
                        setPrompt({ ssid: ap.ssid, ap, onConnect: connect })
                        return
                    }
                    restore()
                    fail("Connection failed", e)
                })
            // bluez-grade hang guard: NM may never answer on some failures
            setTimeout(() => {
                if (connectingBssid.get() === ap.bssid) {
                    restore()
                    fail("Connection failed", "timed out")
                }
            }, 45_000)
        }

        function onClick() {
            if (busy.get()) return
            setError("")
            if (active.get()) return disconnect()
            if (!secured(ap)) return connect()
            if (!isKnown.get()) return setPrompt({ ssid: ap.ssid, ap, onConnect: connect })
            // known + secured: a saved connection without a stored PSK
            // makes "connection up" fail after a dead agent round-trip
            // (and pops the nm-applet modal for an already-aborted
            // activation). Check for a stored secret first — secretless
            // goes straight to our prompt
            execAsync([
                "nmcli",
                "-s",
                "-t",
                "-f",
                "802-11-wireless-security.psk",
                "connection",
                "show",
                profileId(ap),
            ])
                .then(out => {
                    const psk = out.trim().replace(/^802-11-wireless-security\.psk:/, "")
                    if (psk) connect()
                    else setPrompt({ ssid: ap.ssid, ap, onConnect: connect })
                })
                .catch(() => connect())
        }

        function toggleAutoconnect() {
            const next = autoconnect.get() !== true
            setAutoconnect(next)
            execAsync([
                "nmcli",
                "connection",
                "modify",
                profileId(ap),
                "connection.autoconnect",
                next ? "yes" : "no",
            ]).catch(e => {
                setAutoconnect(!next)
                console.warn("wifi autoconnect failed:", e)
            })
        }

        function loadAutoconnect() {
            if (autoconnect.get() !== null) return
            execAsync([
                "nmcli",
                "-t",
                "-f",
                "connection.autoconnect",
                "connection",
                "show",
                profileId(ap),
            ])
                .then(out => setAutoconnect(out.trim().endsWith("yes")))
                .catch(() => {})
        }

        const sec = securityOf(ap)
        const details: [string, string][] = [
            ["BSSID", ap.bssid],
            ["Band", `${bandOf(ap)} (ch ${Math.round(channelOf(ap.frequency))})`],
            ["Max bitrate", ap.maxBitrate > 0 ? `${Math.round(ap.maxBitrate / 1000)} Mb/s` : "—"],
            ["Security", sec],
        ]

        return (
            <box orientation={Gtk.Orientation.VERTICAL}>
                <box
                    cssName={"button"}
                    cssClasses={active.as(a => (a ? ["wifiAp", "active"] : ["wifiAp"]))}
                    // dim rows blocked while another network connects
                    css={connectingBssid.as(b =>
                        b !== null && b !== ap.bssid ? "opacity: 0.45;" : "",
                    )}
                    spacing={5}
                >
                    {/* gesture only on the info area: nested buttons must not
                    re-trigger the row click */}
                    <box spacing={5} hexpand>
                        <Gtk.GestureClick button={1} onPressed={onClick} />
                        <OverlayIcon
                            icon={createBinding(ap, "iconName")}
                            badge={bandBadgeOf(ap.frequency)}
                        />
                        <box orientation={Gtk.Orientation.VERTICAL} hexpand>
                            <label
                                label={ap.ssid}
                                xalign={0}
                                maxWidthChars={24}
                                ellipsize={Pango.EllipsizeMode.END}
                            />
                            <label cssClasses={statusClass} label={status} xalign={0} />
                        </box>
                    </box>
                    {secured(ap) && <image iconName="changes-prevent-symbolic" pixelSize={12} />}
                    <button
                        cssClasses={["details"]}
                        tooltipText={"Network details"}
                        onClicked={() => {
                            const opening = !detailsOpen.get()
                            setDetailsOpen(opening)
                            if (opening && isKnown.get()) loadAutoconnect()
                        }}
                    >
                        <image
                            iconName={detailsOpen.as(o =>
                                o ? "pan-up-symbolic" : "dialog-information-symbolic",
                            )}
                        />
                    </button>
                    <button
                        cssClasses={["forget"]}
                        visible={createComputed([active, isKnown], (a, k) => !a && k)}
                        tooltipText={"Forget network"}
                        onClicked={() => {
                            execAsync(["nmcli", "connection", "delete", "id", profileId(ap)]).catch(
                                e => console.warn("wifi forget failed:", e),
                            )
                        }}
                    >
                        <image iconName="user-trash-symbolic" />
                    </button>
                </box>
                <revealer
                    revealChild={detailsOpen}
                    transitionDuration={150}
                    transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
                >
                    <box cssClasses={["wifiDetails"]} orientation={Gtk.Orientation.VERTICAL}>
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
                        <box
                            visible={isKnown}
                            cssName={"button"}
                            spacing={5}
                            cssClasses={autoconnect.as(a => (a === true ? ["active"] : [""]))}
                        >
                            <Gtk.GestureClick button={1} onPressed={toggleAutoconnect} />
                            <label label={"Auto-connect"} hexpand xalign={0} />
                            <image
                                iconName={autoconnect.as(a =>
                                    a === true ? "object-select-symbolic" : "window-close-symbolic",
                                )}
                            />
                        </box>
                    </box>
                </revealer>
            </box>
        )
    }

    function PasswordPrompt({ p }: { p: Prompt }) {
        let entry: Gtk.Entry | null = null
        let ssidEntry: Gtk.Entry | null = null

        function submit() {
            const password = entry?.get_text() ?? ""
            if (p.ap) {
                p.onConnect?.(password)
            } else {
                const ssid = ssidEntry?.get_text() ?? ""
                if (!ssid) return
                const args = ["nmcli", "device", "wifi", "connect", ssid]
                if (password) args.push("password", password)
                args.push("hidden", "yes")
                execAsync(args).catch(e => console.warn("wifi hidden join failed:", e))
            }
            setPrompt(null)
        }

        return (
            <box cssClasses={["wifiPrompt"]} orientation={Gtk.Orientation.VERTICAL} spacing={10}>
                <label
                    cssClasses={["title"]}
                    label={p.ap ? `Connect to ${p.ssid}` : "Join hidden network"}
                    xalign={0}
                />
                {!p.ap && (
                    <Gtk.Entry
                        $={self => {
                            ssidEntry = self
                        }}
                        placeholderText={"Network name (SSID)"}
                        onActivate={submit}
                    />
                )}
                <Gtk.Entry
                    $={self => {
                        entry = self
                        self.grab_focus()
                    }}
                    placeholderText={"Password (empty for open)"}
                    visibility={false}
                    inputPurpose={Gtk.InputPurpose.PASSWORD}
                    onActivate={submit}
                />
                <box spacing={8} halign={Gtk.Align.END}>
                    <button cssName={"button"} onClicked={() => setPrompt(null)}>
                        <label label={"Cancel"} />
                    </button>
                    <button cssName={"button"} cssClasses={["confirm"]} onClicked={submit}>
                        <label label={"Connect"} />
                    </button>
                </box>
            </box>
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
            <With value={prompt}>{p => p && <PasswordPrompt p={p} />}</With>
            <box orientation={Gtk.Orientation.VERTICAL} visible={prompt.as(p => p === null)}>
                {/* 2-state on/off slider (no label: the pane header
                already says Wi-Fi) */}
                <box cssClasses={["wifiSwitchRow"]} hexpand>
                    <Gtk.Switch
                        halign={Gtk.Align.END}
                        active={createBinding(wifi, "enabled")}
                        onNotifyActive={self => wifi.set_enabled(self.active)}
                    />
                </box>
                <Gtk.Separator />
                <ConnectedSection wifi={wifi} />
                <Gtk.Separator />
                <box
                    orientation={Gtk.Orientation.VERTICAL}
                    visible={createBinding(wifi, "enabled")}
                >
                    <box>
                        <label label={"Networks"} cssClasses={["btSection"]} xalign={0} hexpand />
                        <button
                            cssClasses={["rescan"]}
                            tooltipText={"Scan again"}
                            sensitive={rescanning.as(r => !r)}
                            onClicked={rescan}
                        >
                            <box>
                                <Gtk.Spinner $={self => self.start()} visible={rescanning} />
                                <image
                                    iconName="view-refresh-symbolic"
                                    visible={rescanning.as(r => !r)}
                                />
                            </box>
                        </button>
                    </box>
                    {/* For in its own container: it re-appends children at
                    the parent's end on every update, which would float
                    the join row above the networks */}
                    <box orientation={Gtk.Orientation.VERTICAL}>
                        <For each={sortedAps}>{ap => <ApRow ap={ap} />}</For>
                    </box>
                    <box cssName={"button"} spacing={5}>
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
    )
}
