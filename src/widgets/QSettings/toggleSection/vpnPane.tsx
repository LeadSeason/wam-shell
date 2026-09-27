import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import Pango from "gi://Pango?version=1.0"
import { Accessor, For, createComputed, createState, onCleanup } from "gnim"
import { qsVisible } from "../MediaSection"
import {
    isConnected,
    type VpnBackend,
    type VpnDevice,
    type VpnFeature,
    type VpnLocation,
} from "../../../lib/vpn"

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
// backends without the logged-out concept (an NM profile): the pane
// falls back to these and behaves as it always did
const NEVER_LOGGED_OUT = new Accessor(() => false)
// fallbacks for the optional VpnFeature gates: absent `available`
// means always offered; absent `attention` means no attention state.
// NOT interchangeable — one defaults true, the other false
const ALWAYS_AVAILABLE = new Accessor(() => true)
const NEVER_ATTENTION = new Accessor(() => false)

// a tailnet string onto the clipboard via wl-copy — the wifiApRow idiom
// (subprocess + stdin pipe; its comment records why the pipe cannot
// stall), with the same never-log-the-payload rule. Copied so far: a
// device's tailscale address (pasting into a browser) and the operator
// fix command (pasting into a terminal). An address is not a secret,
// but the habit costs nothing
function copyText(text: string) {
    if (!text) return
    if (GLib.find_program_in_path("wl-copy") === null) {
        console.warn("vpn: wl-copy not found — address not copied")
        return
    }
    let copier: Gio.Subprocess | null = null
    try {
        copier = Gio.Subprocess.new(["wl-copy"], Gio.SubprocessFlags.STDIN_PIPE)
        const sink = copier.get_stdin_pipe()
        if (!sink) throw new Error("no stdin pipe")
        sink.write_all(text, null)
        sink.close(null)
    } catch {
        copier?.force_exit()
        console.warn("vpn: clipboard copy failed")
    }
}

function FeatureRow({ feature, busy }: { feature: VpnFeature; busy: Accessor<boolean> }) {
    const available = feature.available ?? ALWAYS_AVAILABLE
    const attention = feature.attention ?? NEVER_ATTENTION
    return (
        <box
            // the tracking form, not the deps-array form: NEVER_ATTENTION
            // is a constant-false dep, and the deps-array cache keys on
            // falsy checks (AGENTS.md)
            cssClasses={createComputed(track => [
                "vpnFeature",
                // locked (not offered) and attention (offered but
                // ineffective until the user acts) are different
                // statements and wear different colors
                ...(track(available) ? (track(attention) ? ["attention"] : []) : ["unavailable"]),
            ])}
            spacing={6}
        >
            {/* a feature the tailnet does not offer: padlocked and dim,
            distinct from the transient "value not read yet" state that
            shares the insensitive switch. changes-prevent is the
            padlock pair Adwaita draws for exactly this */}
            <image
                cssClasses={["vpnFeatureLock"]}
                iconName={"changes-prevent-symbolic"}
                valign={Gtk.Align.CENTER}
                visible={available.as(a => !a)}
            />
            <box orientation={Gtk.Orientation.VERTICAL} hexpand>
                <box spacing={6}>
                    <label
                        cssClasses={["featLabel"]}
                        xalign={0}
                        label={feature.label}
                        tooltipText={feature.tooltip ?? ""}
                    />
                    {/* the attention state in words, not just the
                    warning color: offered, but tailnet policy blocks it
                    until the user acts (see VpnFeature.attention) */}
                    <label
                        cssClasses={["vpnFeatureFlag"]}
                        valign={Gtk.Align.CENTER}
                        visible={createComputed(track => track(available) && track(attention))}
                        label={"blocked by policy"}
                    />
                </box>
                {feature.description !== undefined && (
                    <label
                        cssClasses={["dim"]}
                        xalign={0}
                        maxWidthChars={34}
                        wrap
                        wrapMode={Pango.WrapMode.WORD}
                        label={feature.description}
                    />
                )}
            </box>
            <Gtk.Switch
                valign={Gtk.Align.CENTER}
                active={feature.value.as(v => v === true)}
                sensitive={createComputed(
                    [busy, feature.value, available],
                    (b, v, a) => !b && v !== null && a,
                )}
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
                // same semantics as the quick settings toggle: "blocked"
                // (the Failed hold) is down in every way that matters —
                // offer connect so a retry is not swallowed; anything
                // else but fully disconnected → disconnect (also the
                // only way to abort a connecting attempt); a flip while
                // already disconnecting is ignored
                const s = status.get().state
                if (s === "disconnected" || s === "blocked") backend.connect()
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
    // absent on backends without the concept (an NM profile) — there
    // the pane behaves exactly as it always did
    const loggedOut = backend.loggedOut ?? NEVER_LOGGED_OUT
    const devices = backend.devices ?? new Accessor<VpnDevice[]>(() => [])

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

    // "my-laptop · key expires in 228d", amber <30d, red when overdue. No
    // expiry date is not "nothing to say" — backends where it is
    // disabled (Tailscale without key expiry) say so, plainly
    const accountAcc = account ?? new Accessor(() => null)
    const accountText = accountAcc.as(a => {
        if (!a) return ""
        const days = a.expiryMs !== null ? Math.ceil((a.expiryMs - Date.now()) / DAY_MS) : null
        // "key expiry": Tailscale expires the node's key, not the
        // account — name it, or "expiry disabled" reads like a
        // subscription state
        const time =
            days === null
                ? "key expiry disabled"
                : days < 0
                  ? `key ${-days}d overdue`
                  : `key expires in ${days}d`
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
                                    // no exit node → no tunnel endpoint:
                                    // say so rather than print an empty row
                                    label={details.as(d =>
                                        d && d.endpoint !== "" ? d.endpoint : "none",
                                    )}
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
                {/* health warnings: an attention chip, not a tinted
                    line — UDP blocked / captive portal is the headline
                    fact on this pane when it applies. Yellow tier:
                    informational, the connection still works */}
                {backend.warnings && (
                    <box cssClasses={["vpnWarn"]} visible={backend.warnings.as(w => w.length > 0)}>
                        <label
                            cssClasses={["vpnWarnText"]}
                            xalign={0}
                            hexpand
                            maxWidthChars={34}
                            wrap
                            wrapMode={Pango.WrapMode.WORD}
                            label={backend.warnings.as(w => w.join(" "))}
                        />
                    </box>
                )}
                {/* an action failed for a fixable reason (missing
                operator rights) — name the problem in red instead of
                letting the click look dead. The remedies sit in the
                actions row below, where this pane's buttons live */}
                {backend.notice && (
                    <label
                        cssClasses={["vpnNotice"]}
                        xalign={0}
                        maxWidthChars={38}
                        wrap
                        wrapMode={Pango.WrapMode.WORD}
                        visible={backend.notice.as(n => n !== null)}
                        label={backend.notice.as(n => n?.text ?? "")}
                    />
                )}
            </box>

            <box spacing={6}>
                {/* re-authentication only: the backend's login starts the
                auth-URL flow and opens it in the browser, and it is
                only meaningful when the node actually lacks a tailnet
                identity — backends with the concept gate on their
                loggedOut flag. A stopped-but-logged-in node offers
                Reconnect alone: Login there reads as "you were logged
                out", which stopping the tunnel never does */}
                {backend.login && (
                    <button
                        cssClasses={["vpnAction"]}
                        visible={
                            backend.loggedOut
                                ? loggedOut
                                : status.as(s => s.state === "disconnected")
                        }
                        sensitive={busy.as(b => !b)}
                        onClicked={() => backend.login?.()}
                    >
                        <label label={"Login…"} />
                    </button>
                )}
                {/* the escape hatch the pane lacked: aborts an in-flight
                attempt too, so it shows whenever not fully
                disconnected. Meaningless while logged out — there is
                nothing to disconnect: Login alone applies */}
                <button
                    cssClasses={["vpnAction"]}
                    visible={createComputed(
                        [status, loggedOut],
                        (s, lo) => s.state !== "disconnected" && !lo,
                    )}
                    sensitive={busy.as(b => !b)}
                    onClicked={() => backend.disconnect()}
                >
                    <label label={"Disconnect"} />
                </button>
                {/* no tunnel exists to reconnect while logged out —
                Login is the path back */}
                <button
                    cssClasses={["vpnAction"]}
                    visible={loggedOut.as(lo => !lo)}
                    sensitive={busy.as(b => !b)}
                    onClicked={() => backend.reconnect()}
                >
                    <label label={"Reconnect"} />
                </button>
                {locations && (
                    <button
                        cssClasses={["vpnAction"]}
                        visible={loggedOut.as(lo => !lo)}
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
                {/* the notice's remedies, beside the other actions and
                    only while the problem stands: polkit escalation
                    when pkexec exists, otherwise the clipboard copy of
                    the bare command as the manual path */}
                {backend.notice && (
                    <button
                        cssClasses={["vpnAction"]}
                        tooltipText={backend.notice.as(n =>
                            n?.command ? `Run “${n.command}” (asks for the admin password)` : "",
                        )}
                        visible={backend.notice.as(n => n?.fix !== undefined)}
                        onClicked={() => backend.notice?.get().fix?.run()}
                    >
                        <label label={backend.notice.as(n => n?.fix?.label ?? "")} />
                    </button>
                )}
                {backend.notice && (
                    <button
                        cssClasses={["vpnNoticeCopy"]}
                        valign={Gtk.Align.CENTER}
                        tooltipText={backend.notice.as(n =>
                            n?.command ? `Copy “${n.command}” to clipboard` : "",
                        )}
                        visible={backend.notice.as(
                            n => n?.command !== undefined && n?.fix === undefined,
                        )}
                        onClicked={() => {
                            const cmd = backend.notice?.get().command
                            if (cmd) copyText(cmd)
                        }}
                    >
                        <image iconName={"edit-copy-symbolic"} />
                    </button>
                )}
            </box>

            {/* everything below the actions row is the daemon's last
            read, frozen while the node is logged out — name that, so
            the gray reads as "stale", not "broken". A real heading
            (.vpnLastKnown), not an eyebrow: it names the pane's state,
            not a group within it */}
            <label
                cssClasses={["vpnLastKnown"]}
                xalign={0}
                hexpand
                visible={loggedOut}
                label={"Last known state"}
            />

            {/* searchable location picker behind the button, current
            location marked. Insensitive while logged out: last known
            catalogue, not an offer */}
            {locations && (
                <revealer revealChild={pickerOpen} sensitive={loggedOut.as(lo => !lo)}>
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
                                            // either. "blocked" (the Failed
                                            // hold) is NOT flux — a notice
                                            // must not lock the picker
                                            sensitive={createComputed(
                                                [busy, status],
                                                (b, s) =>
                                                    !b &&
                                                    s.state !== "connecting" &&
                                                    s.state !== "disconnecting",
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
                                {/* an empty catalogue is a fact about
                                the tailnet (no exit nodes advertised),
                                not a missing load — say so, like the
                                Devices card does */}
                                <label
                                    cssClasses={["dim"]}
                                    xalign={0.5}
                                    maxWidthChars={30}
                                    ellipsize={Pango.EllipsizeMode.END}
                                    visible={filtered.as(l => l.length === 0)}
                                    label={"No exit nodes on this tailnet"}
                                />
                            </box>
                        </Gtk.ScrolledWindow>
                    </box>
                </revealer>
            )}

            {/* tunnel feature toggles, as a card so they read as one unit.
            Above Devices deliberately: this card is a fixed shape, and a
            dynamic list belongs at the bottom where its growth cannot
            push the rest of the pane down. Insensitive while logged
            out: last known prefs, not an offer */}
            {features && (
                <box
                    orientation={Gtk.Orientation.VERTICAL}
                    spacing={10}
                    sensitive={loggedOut.as(lo => !lo)}
                >
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

            {/* the backend's peer catalogue (Tailscale's tailnet):
            online rows bright, offline rows dimmed with their age.
            A click copies the device's tailscale address (for pasting
            into a browser) — the tooltip says what will land. Last in
            the pane: the list grows and shrinks with the tailnet.
            Insensitive while logged out: the tailnet's last known
            state, not a live list */}
            {backend.devices && (
                <box
                    orientation={Gtk.Orientation.VERTICAL}
                    spacing={10}
                    sensitive={loggedOut.as(lo => !lo)}
                >
                    <label cssClasses={["paneSection"]} xalign={0} label={"Devices"} hexpand />
                    <box cssClasses={["vpnDevices"]} orientation={Gtk.Orientation.VERTICAL}>
                        <Gtk.ScrolledWindow
                            vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
                            hscrollbarPolicy={Gtk.PolicyType.NEVER}
                            propagateNaturalHeight
                            maxContentHeight={180}
                        >
                            <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                                <For each={devices}>
                                    {(dev: VpnDevice) => (
                                        <button
                                            cssClasses={[
                                                "vpnDevice",
                                                ...(dev.online ? ["online"] : []),
                                                ...(dev.self ? ["self"] : []),
                                            ]}
                                            hexpand
                                            sensitive={dev.copy !== ""}
                                            tooltipText={
                                                dev.copy !== ""
                                                    ? `Copy ${dev.copy} to clipboard`
                                                    : dev.label
                                            }
                                            onClicked={() => copyText(dev.copy)}
                                        >
                                            <box spacing={8}>
                                                <box
                                                    cssClasses={["vpnDeviceDot"]}
                                                    valign={Gtk.Align.CENTER}
                                                />
                                                <box orientation={Gtk.Orientation.VERTICAL} hexpand>
                                                    <box spacing={6}>
                                                        <label
                                                            cssClasses={["devName"]}
                                                            xalign={0}
                                                            label={dev.label}
                                                        />
                                                        {dev.self && (
                                                            <label
                                                                cssClasses={["vpnDeviceSelf"]}
                                                                valign={Gtk.Align.CENTER}
                                                                label={"this device"}
                                                            />
                                                        )}
                                                    </box>
                                                    <label
                                                        cssClasses={["dim"]}
                                                        xalign={0}
                                                        visible={dev.meta !== ""}
                                                        label={dev.meta}
                                                    />
                                                </box>
                                            </box>
                                        </button>
                                    )}
                                </For>
                                <label
                                    cssClasses={["dim"]}
                                    xalign={0.5}
                                    visible={devices.as(l => l.length === 0)}
                                    label={"No devices"}
                                />
                            </box>
                        </Gtk.ScrolledWindow>
                    </box>
                </box>
            )}
        </box>
    )
}
