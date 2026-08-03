import { Accessor, createBinding, createState, onCleanup, With } from "gnim"
import { PaneEmpty } from "../../PaneEmpty"
import { execAsync } from "../../../lib/metrics"
import { DropdownButton } from "./ToggleButton"
import AstalNetwork from "gi://AstalNetwork?version=0.1"
import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango?version=1.0"

const DS = AstalNetwork.DeviceState

function wiredToggle(wired: AstalNetwork.Wired) {
    const device = wired.device
    if (!device) return
    // no cable: connecting would just fail with "no carrier"
    if (wired.state === DS.UNAVAILABLE) return
    const iface = device.get_iface()
    if (!iface) {
        console.warn("Wired toggle: device has no interface name")
        return
    }
    const activated = wired.state === DS.ACTIVATED
    execAsync(["nmcli", "device", activated ? "disconnect" : "connect", iface]).catch(e =>
        console.warn("wired toggle failed:", e),
    )
}

function stateLabel(wired: AstalNetwork.Wired, state: AstalNetwork.DeviceState): string {
    switch (state) {
        case DS.ACTIVATED:
            return wired.speed > 0 ? `${wired.speed} Mb/s` : "Connected"
        case DS.UNAVAILABLE:
            return "Cable unplugged"
        case DS.DISCONNECTED:
            return "Disconnected"
        default:
            return "Connecting…"
    }
}

export function WiredButton({ navigate }: { navigate: () => void }) {
    // Network.wired goes null when the ethernet device is removed
    // (USB-C dongles): rebind so the toggle drops out of the grid
    // instead of staying frozen at its last state
    return (
        <With value={createBinding(AstalNetwork.get_default(), "wired")}>
            {wired => wired && <WiredToggleButton wired={wired} navigate={navigate} />}
        </With>
    )
}

function WiredToggleButton({
    wired,
    navigate,
}: {
    wired: AstalNetwork.Wired
    navigate: () => void
}) {
    const subtitle = createBinding(wired, "state").as(s => stateLabel(wired, s))

    return (
        <DropdownButton
            navigate={navigate}
            icon={createBinding(wired, "iconName")}
            label={"Wired"}
            subtitle={subtitle}
            isActive={createBinding(wired, "state").as(s => s === DS.ACTIVATED)}
            activate={() => wiredToggle(wired)}
        />
    )
}

interface wiredDetails {
    iface: string
    ipv4: string
    gateway: string
    dns: string
    ipv6: string
}

export function WiredWidget({ pane, name }: { pane: Accessor<string>; name: string }) {
    // same rebind as the toggle: a removed device shows a centered
    // empty state (the header stays) instead of stale details
    return (
        <With value={createBinding(AstalNetwork.get_default(), "wired")}>
            {wired =>
                wired ? (
                    <WiredPane wired={wired} pane={pane} name={name} />
                ) : (
                    <PaneEmpty
                        icon="network-wired-symbolic"
                        title={"No wired device"}
                        hint={"Connect a cable or adapter"}
                    />
                )
            }
        </With>
    )
}

/** the connect/disconnect switch in the wired pane's header row */
export function WiredSwitch() {
    return (
        <With value={createBinding(AstalNetwork.get_default(), "wired")}>
            {wired =>
                wired && (
                    <Gtk.Switch
                        cssClasses={["paneSwitch"]}
                        valign={Gtk.Align.CENTER}
                        active={createBinding(wired, "state").as(s => s === DS.ACTIVATED)}
                        onNotifyActive={self => {
                            // idempotent: binding syncs must not toggle
                            if (self.active !== (wired.state === DS.ACTIVATED)) {
                                wiredToggle(wired)
                                // wiredToggle is a no-op without a cable:
                                // the switch must not stay flipped on
                                if (wired.state === DS.UNAVAILABLE)
                                    self.set_state(wired.state === DS.ACTIVATED)
                            }
                        }}
                    />
                )
            }
        </With>
    )
}

function WiredPane({
    wired,
    pane,
    name,
}: {
    wired: AstalNetwork.Wired
    pane: Accessor<string>
    name: string
}) {
    const [details, setDetails] = createState<wiredDetails>({
        iface: "",
        ipv4: "",
        gateway: "",
        dns: "",
        ipv6: "",
    })

    function refresh() {
        const iface = wired.device?.get_iface()
        if (!iface) return
        execAsync(["nmcli", "-t", "device", "show", iface])
            .then(out => {
                const get = (key: string) =>
                    // values may contain colons (IPv6) — split at the first
                    out
                        .split("\n")
                        .find(l => l.startsWith(key))
                        ?.slice(key.length + 1) ?? ""
                setDetails({
                    iface,
                    ipv4: get("IP4.ADDRESS[1]"),
                    gateway: get("IP4.GATEWAY"),
                    dns: [get("IP4.DNS[1]"), get("IP4.DNS[2]")].filter(Boolean).join(", "),
                    ipv6: get("IP6.ADDRESS[1]"),
                })
            })
            // races with NM dropping the device (dongle pulled mid-exec)
            .catch(e => console.warn("wired details failed:", e))
    }

    // the widget remounts on device removal/swap: drop the old
    // subscriptions or they stack on the long-lived pane accessor
    const disposers = [
        pane.subscribe(() => {
            if (pane.get() === name) refresh()
        }),
        createBinding(wired, "state").subscribe(refresh),
    ]
    onCleanup(() => {
        for (const d of disposers) d()
    })
    refresh()

    const state = createBinding(wired, "state")
    const activated = state.as(s => s === DS.ACTIVATED)

    return (
        <box cssClasses={["wiredPane"]} orientation={Gtk.Orientation.VERTICAL}>
            <box cssClasses={["paneCard"]} orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                <box
                    cssName={"button"}
                    spacing={5}
                    cssClasses={activated.as(a => ["paneRow", ...(a ? ["active"] : [])])}
                >
                    <Gtk.GestureClick button={1} onPressed={() => wiredToggle(wired)} />
                    <image iconName={createBinding(wired, "iconName")} />
                    <label
                        cssClasses={["paneRowName"]}
                        label={state.as(s => stateLabel(wired, s))}
                        hexpand
                        xalign={0}
                    />
                    <label
                        cssClasses={["status"]}
                        label={activated.as(a => (a ? "Disconnect" : "Connect"))}
                    />
                </box>
                <box cssClasses={["wifiDetails"]} orientation={Gtk.Orientation.VERTICAL}>
                    {(
                        [
                            ["Interface", details.as(d => d.iface || "—")],
                            [
                                "Speed",
                                createBinding(wired, "speed").as(s => (s > 0 ? `${s} Mb/s` : "—")),
                            ],
                            ["IPv4", details.as(d => d.ipv4 || "—")],
                            ["Gateway", details.as(d => d.gateway || "—")],
                            ["DNS", details.as(d => d.dns || "—")],
                            ["IPv6", details.as(d => d.ipv6 || "—")],
                        ] as [string, any][]
                    ).map(([key, value]) => (
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
                </box>
            </box>
        </box>
    )
}
