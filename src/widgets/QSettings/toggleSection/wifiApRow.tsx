import { Accessor, Setter, createBinding, createComputed, createState } from "gnim"
import { OverlayIcon, bandBadgeOf } from "./ToggleButton"
import AstalNetwork from "gi://AstalNetwork?version=0.1"
import { execAsync } from "../../../lib/metrics"
import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango?version=1.0"
import { savedNetworks, profileId } from "./savedNetworks"

// NM 80211ApSecurityFlags key-mgmt bits
const KEY_MGMT_PSK = 0x100
const KEY_MGMT_802_1X = 0x200
const KEY_MGMT_SAE = 0x400

export function securityOf(ap: AstalNetwork.AccessPoint): string {
    if (ap.rsnFlags & KEY_MGMT_SAE) return "WPA3"
    if (ap.rsnFlags & KEY_MGMT_PSK) return "WPA2"
    if (ap.rsnFlags & KEY_MGMT_802_1X) return "Enterprise"
    if (ap.rsnFlags !== 0) return "WPA2"
    if (ap.wpaFlags !== 0) return "WPA"
    return "Open"
}

const secured = (ap: AstalNetwork.AccessPoint) => ap.rsnFlags !== 0 || ap.wpaFlags !== 0

export function bandOf(ap: AstalNetwork.AccessPoint): string {
    if (ap.frequency >= 5925) return "6GHz"
    if (ap.frequency >= 5000) return "5GHz"
    return "2.4GHz"
}

export function channelOf(freq: number): number {
    if (freq === 2484) return 14
    if (freq < 2484) return (freq - 2407) / 5
    if (freq < 5000) return (freq - 2510) / 5 + 15 // rough
    return (freq - 5000) / 5
}

// password prompt: replaces the pane content while set
export interface WifiPrompt {
    ssid: string
    ap: AstalNetwork.AccessPoint | null // null = hidden join
    /** row connect() so prompt-driven connects share pending/error */
    onConnect?: (password: string) => void
}

interface ApRowProps {
    ap: AstalNetwork.AccessPoint
    wifi: AstalNetwork.Wifi
    /** bssid of the AP currently being connected, null when idle —
     *  pane-wide mutual exclusion for connection attempts */
    connectingBssid: Accessor<string | null>
    setConnectingBssid: Setter<string | null>
    setPrompt: Setter<WifiPrompt | null>
    disconnect: () => void
}

export function ApRow({
    ap,
    wifi,
    connectingBssid,
    setConnectingBssid,
    setPrompt,
    disconnect,
}: ApRowProps) {
    const [error, setError] = createState("")
    const [detailsOpen, setDetailsOpen] = createState(false)
    const [autoconnect, setAutoconnect] = createState<boolean | null>(null)
    let errorToken = 0
    // token guards the 45s hang guard and the late .then/.catch
    // against a newer attempt on the same AP (a stale completion
    // must not restore/fail the current attempt)
    let connectAttempt = 0

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
        const attempt = ++connectAttempt
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
            .then(() => {
                if (attempt !== connectAttempt) return
                setConnectingBssid(null)
            })
            .catch(e => {
                if (attempt !== connectAttempt) return
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
            if (attempt !== connectAttempt) return
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
                cssClasses={active.as(a => ["wifiAp", "paneRow", ...(a ? ["active"] : [])])}
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
                            cssClasses={["paneRowName"]}
                            label={ap.ssid}
                            xalign={0}
                            maxWidthChars={24}
                            ellipsize={Pango.EllipsizeMode.END}
                        />
                        <label cssClasses={statusClass} label={status} xalign={0} />
                    </box>
                </box>
                {/* the chevron fades in on row hover (scss) and
                stays lit while its panel is open; its slot keeps
                the width so rows never shift. security is in the
                details panel — no per-row lock icon */}
                <box cssClasses={["wifiActions"]}>
                    <box widthRequest={32} halign={Gtk.Align.CENTER}>
                        <button
                            cssClasses={detailsOpen.as(o =>
                                o ? ["details", "open"] : ["details"],
                            )}
                            tooltipText={"Network details"}
                            onClicked={() => {
                                const opening = !detailsOpen.get()
                                setDetailsOpen(opening)
                                if (opening && isKnown.get()) loadAutoconnect()
                            }}
                        >
                            <image
                                iconName={detailsOpen.as(o =>
                                    o ? "pan-up-symbolic" : "pan-down-symbolic",
                                )}
                            />
                        </button>
                    </box>
                </box>
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
                    <box visible={isKnown} spacing={5} cssClasses={["wifiDetailAction"]}>
                        <Gtk.GestureClick button={1} onPressed={toggleAutoconnect} />
                        <label label={"Auto-connect"} hexpand xalign={0} />
                        <Gtk.CheckButton
                            cssClasses={["paneCheckbox"]}
                            valign={Gtk.Align.CENTER}
                            sensitive={false}
                            active={autoconnect.as(a => a === true)}
                        />
                    </box>
                    <box
                        visible={createComputed([active, isKnown], (a, k) => !a && k)}
                        spacing={5}
                        cssClasses={["wifiDetailAction"]}
                    >
                        <Gtk.GestureClick
                            button={1}
                            onPressed={() => {
                                execAsync([
                                    "nmcli",
                                    "connection",
                                    "delete",
                                    "id",
                                    profileId(ap),
                                ]).catch(e => console.warn("wifi forget failed:", e))
                            }}
                        />
                        <label label={"Forget network"} hexpand xalign={0} />
                        <image iconName="user-trash-symbolic" />
                    </box>
                </box>
            </revealer>
        </box>
    )
}

interface PasswordPromptProps {
    p: WifiPrompt
    connectingBssid: Accessor<string | null>
    setConnectingBssid: Setter<string | null>
    setPrompt: Setter<WifiPrompt | null>
}

export function PasswordPrompt({
    p,
    connectingBssid,
    setConnectingBssid,
    setPrompt,
}: PasswordPromptProps) {
    let entry: Gtk.Entry | null = null
    let ssidEntry: Gtk.Entry | null = null
    // hidden join: failures (typically a wrong password) must not
    // vanish silently — the prompt stays open with an error
    const [error, setError] = createState("")

    function submit() {
        const password = entry?.get_text() ?? ""
        if (p.ap) {
            p.onConnect?.(password)
            setPrompt(null)
        } else {
            if (connectingBssid.get() !== null) return // an attempt is in flight
            const ssid = ssidEntry?.get_text() ?? ""
            if (!ssid) return
            const args = ["nmcli", "device", "wifi", "connect", ssid]
            if (password) args.push("password", password)
            args.push("hidden", "yes")
            // join the pane-wide mutual exclusion (and debounce
            // double submits): rows stay blocked while this runs
            setConnectingBssid(`hidden:${ssid}`)
            execAsync(args)
                .then(() => {
                    setConnectingBssid(null)
                    setPrompt(null)
                })
                .catch(e => {
                    setConnectingBssid(null)
                    console.warn("wifi hidden join failed:", e)
                    setError("Couldn't join — check the SSID and password")
                })
        }
    }

    return (
        <box
            cssClasses={["wifiPrompt", "paneCard"]}
            orientation={Gtk.Orientation.VERTICAL}
            spacing={10}
        >
            <label
                cssClasses={["title"]}
                label={p.ap ? `Connect to ${p.ssid}` : "Join hidden network"}
                xalign={0}
            />
            <label
                cssClasses={["status", "error"]}
                xalign={0}
                visible={error.as(e => e !== "")}
                label={error}
            />
            {!p.ap && (
                <Gtk.Entry
                    $={self => {
                        ssidEntry = self
                    }}
                    cssClasses={["textInput"]}
                    placeholderText={"Network name (SSID)"}
                    onActivate={submit}
                />
            )}
            <Gtk.Entry
                $={self => {
                    entry = self
                    self.grab_focus()
                }}
                cssClasses={["textInput"]}
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
