import { Gtk } from "ags/gtk4"
import { createBinding, createState, onCleanup, With } from "gnim"
import { execAsync, connect, disconnect } from "../../../lib/metrics"
import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import AstalNetwork from "gi://AstalNetwork?version=0.1"
import { DropdownButton } from "./ToggleButton"
import Config from "../../../config"
import { setThemeLive } from "../../../lib/style"
import hyprsunset, { setNightLightEnabled, tempBackend } from "../../../lib/hyprsunset"
import { inhibited, toggleIdleInhibit } from "../../../lib/idleInhibit"

const has = (bin: string) => GLib.find_program_in_path(bin) !== null

export function NightLightButton() {
    // Bound, not read once: detecting the gsettings backend costs a
    // `gsettings get` plus a `pgrep`, and those are async now (they used
    // to block the main loop at import). They answer after this widget
    // is built, so a snapshot here read "no backend" and hid the toggle
    // for the whole session on a gnome-settings-daemon desktop.
    //
    // Inside a box of its own, which is what keeps it in the right CELL.
    // gnim's append() forwards a Fragment's later children straight to
    // the parent's appendChild — for the FlowBox that is
    // gtk_flow_box_insert(box, child, -1) — and does not remember where
    // the Fragment sat. A bare `With` therefore dropped the card past
    // Sleep Timer at the end of the grid the moment the probe answered,
    // reflowing the two-column layout under the user. The box holds the
    // slot and the late append lands inside it.
    //
    // Its visibility is bound, and that is not optional: the FlowBox is
    // homogeneous, so an empty-but-visible box would hold a full blank
    // cell on every session without a night light backend — where the
    // bare `<></>` the other unavailable toggles return contributes no
    // child at all.
    return (
        <box visible={tempBackend.as(b => b !== "none")}>
            <With value={tempBackend}>
                {backend =>
                    backend !== "none" && (
                        <DropdownButton
                            icon={"night-light-symbolic"}
                            label={"Night Light"}
                            subtitle={hyprsunset.nightLight.as(v => (v ? "On" : "Off"))}
                            isActive={hyprsunset.nightLight}
                            activate={() => setNightLightEnabled(!hyprsunset.nightLight.get())}
                        />
                    )
                }
            </With>
        </box>
    )
}

export function DarkStyleButton() {
    if (!has("gsettings")) return <></>
    // new Gio.Settings({schema_id}) on a missing schema aborts the
    // process (a g_error, not a catchable exception) — the gsettings
    // binary can exist without the schema. Look it up first; keep
    // QSettings alive
    const schema = Gio.SettingsSchemaSource.get_default()?.lookup(
        "org.gnome.desktop.interface",
        true,
    )
    // gsettings-desktop-schemas < 42 has no color-scheme key: same
    // uncatchable abort, same guard
    if (!schema || !schema.has_key("color-scheme")) return <></>
    const settings = new Gio.Settings({ settings_schema: schema })
    const [active, setActive] = createState(false)
    // Gio.Settings emits "changed" so external changes (other tools,
    // gsettings CLI) reflect without re-reading on a timer
    const sync = () => setActive(settings.get_string("color-scheme").includes("prefer-dark"))
    sync()
    const h = connect(settings, "changed::color-scheme", sync)
    onCleanup(() => disconnect(settings, h))

    return (
        <DropdownButton
            // a half-filled disc, not a crescent: this tile sits beside
            // Night Light, whose icon is also a moon, and two moons in
            // one grid say nothing about which is which
            icon={"dark-mode-symbolic"}
            label={"Dark Style"}
            subtitle={active.as(v => (v ? "On" : "Off"))}
            isActive={active}
            activate={() => {
                const next = !active.get()
                settings.set_string("color-scheme", next ? "prefer-dark" : "default")
                // the changed signal flips `active`; no manual setActive needed
                // the shell itself follows (appearance.dark/light_theme)
                setThemeLive(next ? Config.appearance.darkTheme : Config.appearance.lightTheme)
            }}
        />
    )
}

/** Keep awake: hold off the idle timeout and automatic suspend.
 *
 *  A plain toggle with no dropdown — there is nothing to configure once
 *  it is on, and the one thing worth saying (that it is holding) is
 *  already the subtitle. */
export function KeepAwakeButton() {
    return (
        <DropdownButton
            icon={"caffeine-symbolic"}
            label={"Keep Awake"}
            subtitle={inhibited.as(v => (v ? "Holding" : "Off"))}
            isActive={inhibited}
            activate={toggleIdleInhibit}
        />
    )
}

/** Airplane mode as a row inside the Wi-Fi detail: it kills every
 *  radio, so it belongs with the networks it silences rather than as
 *  its own tile in the grid — where it also read as just another
 *  toggle among nine */
export function AirplaneModeRow() {
    if (!has("nmcli")) return <></>
    const [active, setActive] = createState(false)
    // drop reads issued before the latest refresh: an older `radio all`
    // resolving late must not clobber a newer state (rapid toggles)
    let refreshSeq = 0
    const refresh = () => {
        const seq = ++refreshSeq
        execAsync(["nmcli", "radio", "all"])
            .then(v => {
                if (seq !== refreshSeq) return
                // first line is the header (WIFI-HW WIFI WWAN-HW WWAN);
                // airplane mode = software radios (cols 2 and 4) disabled
                const values = v.trim().split("\n")[1] ?? ""
                const cols = values.split(/\s+/)
                setActive(cols[1] === "disabled" && cols[3] === "disabled")
            })
            .catch(() => {})
    }
    refresh()
    // reflect external changes (keybind, nm-applet): re-check when the
    // wifi radio flips — a free reactive signal, no recurring poll
    const net = AstalNetwork.get_default()
    if (net?.wifi) {
        const unsub = createBinding(net.wifi, "enabled").subscribe(refresh)
        onCleanup(unsub)
    }

    return (
        <box cssClasses={["paneRow"]} spacing={8}>
            <image iconName={"airplane-mode-symbolic"} pixelSize={16} />
            <label cssClasses={["paneRowName"]} label={"Airplane mode"} xalign={0} hexpand />
            <Gtk.Switch
                cssClasses={["paneSwitch"]}
                valign={Gtk.Align.CENTER}
                active={active}
                onNotifyActive={self => {
                    if (self.active === active.get()) return
                    const next = self.active
                    execAsync(["nmcli", "radio", "all", next ? "off" : "on"])
                        .then(() => setActive(next))
                        .catch(() => refresh())
                }}
            />
        </box>
    )
}
