import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango?version=1.0"
import { Accessor, For, createComputed, createState } from "gnim"
import vpnStatus, {
    accountInfo,
    busy,
    ensureLocations,
    featureStates,
    hasMullvad,
    locations,
    reconnect,
    refreshExpiry,
    refreshPaneData,
    setAutoConnect,
    setDaita,
    setDnsBlock,
    setLan,
    setLocation,
    setLockdown,
    setQuantum,
    verbose,
    RelayLocation,
} from "../../../lib/vpn"

// the VPN pane (chevron on the VPN toggle): status detail, reconnect,
// searchable location picker, feature toggles, account expiry. Data is
// fetched on pane open only — nothing here polls.

const DAY_MS = 86_400_000

function FeatureRow({
    label,
    value,
    onToggle,
    tooltip,
}: {
    label: string
    value: Accessor<boolean | null>
    onToggle: (on: boolean) => void
    tooltip?: string
}) {
    return (
        <box cssClasses={["vpnFeature"]} spacing={6}>
            <label xalign={0} hexpand label={label} tooltipText={tooltip ?? ""} />
            <Gtk.Switch
                valign={Gtk.Align.CENTER}
                active={value.as(v => v === true)}
                sensitive={createComputed([busy, value], (b, v) => !b && v !== null)}
                onStateSet={(_s, state) => {
                    // the switch follows the accessor (read-back after the
                    // command), so the gesture only issues it
                    onToggle(state)
                    return true
                }}
            />
        </box>
    )
}

export function VpnPane({ pane, name }: { pane: Accessor<string>; name: string }) {
    if (!hasMullvad) return <></>

    // refresh on pane open; never on a timer
    pane.subscribe(() => {
        if (pane.get() === name) {
            refreshPaneData()
            ensureLocations()
            refreshExpiry()
        }
    })

    const [pickerOpen, setPickerOpen] = createState(false)
    const [query, setQuery] = createState("")
    const filtered = createComputed([locations, query], (locs, q) =>
        locs.filter(l => !q || `${l.country} ${l.city}`.toLowerCase().includes(q.toLowerCase())),
    )

    // current location as "se-sto" from the relay id ("se-sto-wg-205")
    const currentCodes = vpnStatus.as(s =>
        s.connected ? s.relay.split("-").slice(0, 2).join("-") : "",
    )

    // "Stable Mole · 228 days left", amber <30d, red when expired
    const accountText = accountInfo.as(a => {
        if (!a) return ""
        const days = a.expiryMs !== null ? Math.ceil((a.expiryMs - Date.now()) / DAY_MS) : null
        const time = days === null ? "" : days < 0 ? `${-days}d overdue` : `${days} days left`
        return [a.deviceName, time].filter(Boolean).join(" · ")
    })
    const accountClass = accountInfo.as(a => {
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
            {/* status card: state word, location, relay, connection
            details, active features — the Mullvad app card's contents */}
            <box cssClasses={["vpnStatus"]} orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                <label
                    cssClasses={vpnStatus.as(s => ["vpnState", s.connected ? "on" : "off"])}
                    xalign={0}
                    label={vpnStatus.as(s => s.state.toUpperCase())}
                />
                <label
                    cssClasses={["vpnRelay"]}
                    xalign={0}
                    maxWidthChars={34}
                    ellipsize={Pango.EllipsizeMode.END}
                    label={verbose.as(v => v?.location ?? vpnStatus.get().relay ?? "")}
                    visible={vpnStatus.as(s => s.connected)}
                />
                <label
                    cssClasses={["dim"]}
                    xalign={0}
                    maxWidthChars={38}
                    ellipsize={Pango.EllipsizeMode.END}
                    label={verbose.as(v => v?.relay ?? "")}
                    visible={vpnStatus.as(s => s.connected)}
                />
                {/* connection details, like the app's "Connection details" */}
                <box orientation={Gtk.Orientation.VERTICAL} visible={verbose.as(v => v !== null)}>
                    <label
                        cssClasses={["dim"]}
                        xalign={0}
                        label={verbose.as(v => v?.protocol ?? "")}
                    />
                    <box>
                        <label cssClasses={["dim"]} widthChars={4} xalign={0} label={"In"} />
                        <label
                            cssClasses={["dim"]}
                            xalign={0}
                            label={verbose.as(v => v?.endpoint ?? "")}
                        />
                    </box>
                    <box>
                        <label cssClasses={["dim"]} widthChars={4} xalign={0} label={"Out"} />
                        <label
                            cssClasses={["dim"]}
                            xalign={0}
                            label={verbose.as(v => v?.ip ?? "")}
                        />
                    </box>
                </box>
                <label
                    cssClasses={accountClass.as(c => ["dim", "accountLine", ...(c ? [c] : [])])}
                    xalign={0}
                    visible={accountText.as(t => t !== "")}
                    label={accountText}
                />
            </box>

            <box spacing={6}>
                <button
                    cssClasses={["vpnAction"]}
                    sensitive={busy.as(b => !b)}
                    onClicked={() => reconnect()}
                >
                    <label label={"Reconnect"} />
                </button>
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
                <label hexpand />
            </box>

            {/* searchable location picker behind the button, current
            location marked */}
            <revealer revealChild={pickerOpen}>
                <box orientation={Gtk.Orientation.VERTICAL} spacing={6}>
                    <Gtk.Entry
                        cssClasses={["vpnSearch"]}
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
                                {(loc: RelayLocation) => (
                                    <button
                                        cssClasses={currentCodes.as(c => [
                                            "locRow",
                                            ...(c === `${loc.countryCode}-${loc.cityCode}`
                                                ? ["current"]
                                                : []),
                                        ])}
                                        onClicked={() => setLocation(loc.countryCode, loc.cityCode)}
                                    >
                                        <label
                                            xalign={0}
                                            hexpand
                                            maxWidthChars={30}
                                            ellipsize={Pango.EllipsizeMode.END}
                                            label={`${loc.city}, ${loc.country}`}
                                        />
                                    </button>
                                )}
                            </For>
                        </box>
                    </Gtk.ScrolledWindow>
                </box>
            </revealer>

            {/* tunnel feature toggles, as a card so they read as one unit */}
            <label cssClasses={["vpnSectionHeader"]} xalign={0} label={"Features"} />
            <box cssClasses={["vpnFeatures"]} orientation={Gtk.Orientation.VERTICAL} spacing={4}>
                <FeatureRow
                    label={"Quantum Resistance"}
                    value={featureStates.as(f => f.quantum)}
                    onToggle={setQuantum}
                />
                <FeatureRow
                    label={"DAITA"}
                    value={featureStates.as(f => f.daita)}
                    onToggle={setDaita}
                />
                <FeatureRow
                    label={"DNS Content Blocker"}
                    value={featureStates.as(f => f.dnsBlock)}
                    onToggle={setDnsBlock}
                />
                <FeatureRow
                    label={"LAN Sharing"}
                    value={featureStates.as(f => f.lan)}
                    onToggle={setLan}
                />
                <FeatureRow
                    label={"Lockdown Mode"}
                    tooltip={"Blocks ALL traffic when the VPN disconnects, until you reconnect"}
                    value={featureStates.as(f => f.lockdown)}
                    onToggle={setLockdown}
                />
                <FeatureRow
                    label={"Auto-connect"}
                    value={featureStates.as(f => f.autoConnect)}
                    onToggle={setAutoConnect}
                />
            </box>
        </box>
    )
}
