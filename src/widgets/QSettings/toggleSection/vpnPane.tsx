import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango?version=1.0"
import { Accessor, For, createComputed, createState, onCleanup } from "gnim"
import { qsVisible } from "../MediaSection"
import { isConnected, type VpnBackend, type VpnFeature, type VpnLocation } from "../../../lib/vpn"

// The VPN pane (chevron on a VPN toggle): status detail, reconnect,
// searchable location picker, feature toggles, account expiry. Data is
// fetched on pane open only — nothing here polls.
//
// Every section below a backend does not supply is left out entirely
// rather than rendered empty: a backend with no feature toggles gets no
// Features card, one with no server catalogue gets no location picker.
// That is what keeps this one component honest for Mullvad's full
// surface and for a bare NetworkManager profile at the same time.

const DAY_MS = 86_400_000
const NEVER_BUSY = new Accessor(() => false)

function FeatureRow({ feature, busy }: { feature: VpnFeature; busy: Accessor<boolean> }) {
    return (
        <box cssClasses={["vpnFeature"]} spacing={6}>
            <label xalign={0} hexpand label={feature.label} tooltipText={feature.tooltip ?? ""} />
            <Gtk.Switch
                valign={Gtk.Align.CENTER}
                active={feature.value.as(v => v === true)}
                sensitive={createComputed([busy, feature.value], (b, v) => !b && v !== null)}
                onStateSet={(_s, state) => {
                    // the switch follows the accessor (read-back after the
                    // command), so the gesture only issues it
                    feature.set(state)
                    return true
                }}
            />
        </box>
    )
}

/** the connect/disconnect switch in a VPN pane's header row */
export function VpnSwitch({ backend }: { backend: VpnBackend }) {
    const { status } = backend
    return (
        <Gtk.Switch
            cssClasses={["paneSwitch"]}
            valign={Gtk.Align.CENTER}
            visible={backend.active}
            active={status.as(s => isConnected(s))}
            onNotifyActive={self => {
                // idempotent: binding syncs must not toggle
                if (self.active === isConnected(status.get())) return
                // same semantics as the quick settings toggle: anything
                // but fully disconnected → disconnect (also the only way
                // to abort a connecting attempt); a flip while already
                // disconnecting is ignored
                const s = status.get().state
                if (s === "disconnected") backend.connect()
                else if (s !== "disconnecting") backend.disconnect()
            }}
        />
    )
}

export function VpnPane({
    backend,
    pane,
    name,
}: {
    backend: VpnBackend
    pane: Accessor<string>
    name: string
}) {
    const { status, details, account, locations, features } = backend
    const busy = backend.busy ?? NEVER_BUSY

    // refresh on pane open; never on a timer
    onCleanup(
        pane.subscribe(() => {
            if (pane.get() !== name) return
            backend.refreshPane?.()
            locations?.ensure()
        }),
    )

    const [pickerOpen, setPickerOpen] = createState(false)
    const [query, setQuery] = createState("")

    // closed popup = collapsed picker next open, like the toggle
    // section's reset on hide
    onCleanup(
        qsVisible.subscribe(() => {
            if (!qsVisible.get()) {
                setPickerOpen(false)
                setQuery("")
            }
        }),
    )
    const filtered = createComputed(
        [locations?.list ?? new Accessor<VpnLocation[]>(() => []), query],
        (locs, q) => locs.filter(l => !q || l.label.toLowerCase().includes(q.toLowerCase())),
    )

    // "Stable Mole · 228 days left", amber <30d, red when expired
    const accountAcc = account ?? new Accessor(() => null)
    const accountText = accountAcc.as(a => {
        if (!a) return ""
        const days = a.expiryMs !== null ? Math.ceil((a.expiryMs - Date.now()) / DAY_MS) : null
        const time = days === null ? "" : days < 0 ? `${-days}d overdue` : `${days} days left`
        return [a.deviceName, time].filter(Boolean).join(" · ")
    })
    const accountClass = accountAcc.as(a => {
        if (!a || a.expiryMs === null) return ""
        const days = Math.ceil((a.expiryMs - Date.now()) / DAY_MS)
        return days < 0 ? "expired" : days <= 30 ? "expiring" : ""
    })

    return (
        <box
            cssClasses={["vpnPane", "QSSection"]}
            orientation={Gtk.Orientation.VERTICAL}
            spacing={10}
        >
            {/* status card: state word, location, server, connection
            details, account line */}
            <box cssClasses={["vpnStatus"]} orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                <label
                    cssClasses={status.as(s => ["vpnState", isConnected(s) ? "on" : "off"])}
                    xalign={0}
                    label={status.as(s => s.stateLabel.toUpperCase())}
                />
                <label
                    cssClasses={["vpnRelay"]}
                    xalign={0}
                    maxWidthChars={34}
                    ellipsize={Pango.EllipsizeMode.END}
                    label={
                        details
                            ? createComputed([details, status], (d, s) => d?.location ?? s.server)
                            : status.as(s => s.server)
                    }
                    visible={status.as(s => isConnected(s))}
                />
                {details && (
                    <box orientation={Gtk.Orientation.VERTICAL}>
                        <label
                            cssClasses={["dim"]}
                            xalign={0}
                            maxWidthChars={38}
                            ellipsize={Pango.EllipsizeMode.END}
                            label={details.as(d => d?.server ?? "")}
                            visible={status.as(s => isConnected(s))}
                        />
                        {/* connection details, like the app's "Connection details" */}
                        <box
                            orientation={Gtk.Orientation.VERTICAL}
                            visible={details.as(d => d !== null)}
                        >
                            <label
                                cssClasses={["dim"]}
                                xalign={0}
                                label={details.as(d => d?.protocol ?? "")}
                            />
                            <box>
                                <label
                                    cssClasses={["dim"]}
                                    widthChars={4}
                                    xalign={0}
                                    label={"In"}
                                />
                                <label
                                    cssClasses={["dim"]}
                                    xalign={0}
                                    label={details.as(d => d?.endpoint ?? "")}
                                />
                            </box>
                            <box>
                                <label
                                    cssClasses={["dim"]}
                                    widthChars={4}
                                    xalign={0}
                                    label={"Out"}
                                />
                                <label
                                    cssClasses={["dim"]}
                                    xalign={0}
                                    label={details.as(d => d?.ip ?? "")}
                                />
                            </box>
                        </box>
                    </box>
                )}
                {account && (
                    <label
                        cssClasses={accountClass.as(c => ["dim", "accountLine", ...(c ? [c] : [])])}
                        xalign={0}
                        visible={accountText.as(t => t !== "")}
                        label={accountText}
                    />
                )}
            </box>

            <box spacing={6}>
                {/* the escape hatch the pane lacked: aborts an in-flight
                attempt too, so it shows whenever not fully disconnected */}
                <button
                    cssClasses={["vpnAction"]}
                    visible={status.as(s => s.state !== "disconnected")}
                    sensitive={busy.as(b => !b)}
                    onClicked={() => backend.disconnect()}
                >
                    <label label={"Disconnect"} />
                </button>
                <button
                    cssClasses={["vpnAction"]}
                    sensitive={busy.as(b => !b)}
                    onClicked={() => backend.reconnect()}
                >
                    <label label={"Reconnect"} />
                </button>
                {locations && (
                    <button
                        cssClasses={["vpnAction"]}
                        onClicked={() => setPickerOpen(!pickerOpen.get())}
                    >
                        <box spacing={4}>
                            <label label={"Change location"} />
                            <image
                                iconName={pickerOpen.as(o =>
                                    o ? "pan-up-symbolic" : "pan-down-symbolic",
                                )}
                            />
                        </box>
                    </button>
                )}
                <label hexpand />
            </box>

            {/* searchable location picker behind the button, current
            location marked */}
            {locations && (
                <revealer revealChild={pickerOpen}>
                    <box orientation={Gtk.Orientation.VERTICAL} spacing={6}>
                        <Gtk.Entry
                            cssClasses={["textInput"]}
                            placeholderText={"Search locations…"}
                            onChanged={self => setQuery(self.text)}
                        />
                        <Gtk.ScrolledWindow
                            vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
                            hscrollbarPolicy={Gtk.PolicyType.NEVER}
                            propagateNaturalHeight
                            maxContentHeight={200}
                        >
                            <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                                <For each={filtered}>
                                    {(loc: VpnLocation) => (
                                        <button
                                            cssClasses={locations.current.as(c => [
                                                "locRow",
                                                ...(c === loc.id ? ["current"] : []),
                                            ])}
                                            // one switch at a time: a pick
                                            // starts an action (busy) or a
                                            // reconnect (state in flux), and
                                            // spamming rows must not stack
                                            // either
                                            sensitive={createComputed(
                                                [busy, status],
                                                (b, s) =>
                                                    !b &&
                                                    (s.state === "connected" ||
                                                        s.state === "disconnected"),
                                            )}
                                            onClicked={() => loc.select()}
                                        >
                                            <label
                                                xalign={0}
                                                hexpand
                                                maxWidthChars={30}
                                                ellipsize={Pango.EllipsizeMode.END}
                                                label={loc.label}
                                            />
                                        </button>
                                    )}
                                </For>
                            </box>
                        </Gtk.ScrolledWindow>
                    </box>
                </revealer>
            )}

            {/* tunnel feature toggles, as a card so they read as one unit */}
            {features && (
                <box orientation={Gtk.Orientation.VERTICAL} spacing={10}>
                    <label cssClasses={["paneSection"]} xalign={0} label={"Features"} hexpand />
                    <box
                        cssClasses={["vpnFeatures"]}
                        orientation={Gtk.Orientation.VERTICAL}
                        spacing={4}
                    >
                        <For each={features}>
                            {(f: VpnFeature) => <FeatureRow feature={f} busy={busy} />}
                        </For>
                    </box>
                </box>
            )}
        </box>
    )
}
