import { createBinding, createState, onCleanup } from "gnim";
import { exec, execAsync } from "ags/process";
import Gio from "gi://Gio?version=2.0";
import AstalNetwork from "gi://AstalNetwork?version=0.1";
import { DropdownButton } from "./ToggleButton";
import hyprsunset, { setNightLightEnabled, tempBackend } from "../../../lib/hyprsunset";

const has = (bin: string) => {
    try { exec(`which ${bin}`); return true } catch { return false }
}

export function NightLightButton() {
    // no night light backend (hyprctl, gsettings or gammastep)
    if (tempBackend === "none") return <></>
    return <DropdownButton
        icon={"night-light-symbolic"}
        label={"Night Light"}
        subtitle={hyprsunset.nightLight.as(v => v ? "On" : "Off")}
        isActive={hyprsunset.nightLight}
        activate={() => setNightLightEnabled(!hyprsunset.nightLight.get())}
    />
}

export function DarkStyleButton() {
    if (!has("gsettings")) return <></>
    const [active, setActive] = createState(false)
    // Gio.Settings emits "changed" so external changes (other tools,
    // gsettings CLI) reflect without re-reading on a timer
    const settings = new Gio.Settings({ schema_id: "org.gnome.desktop.interface" })
    const sync = () => setActive(
        settings.get_string("color-scheme").includes("prefer-dark"))
    sync()
    const h = settings.connect("changed::color-scheme", sync)
    onCleanup(() => settings.disconnect(h))

    return <DropdownButton
        icon={"weather-clear-night-symbolic"}
        label={"Dark Style"}
        subtitle={active.as(v => v ? "On" : "Off")}
        isActive={active}
        activate={() => {
            const next = !active.get()
            settings.set_string("color-scheme", next ? "prefer-dark" : "default")
            // the changed signal flips `active`; no manual setActive needed
        }}
    />
}

export function AirplaneModeButton() {
    if (!has("nmcli")) return <></>
    const [active, setActive] = createState(false)
    const refresh = () => {
        execAsync(["nmcli", "radio", "all"])
            .then(v => {
                // first line is the header (WIFI-HW WIFI WWAN-HW WWAN);
                // airplane mode = software radios (cols 2 and 4) disabled
                const values = v.trim().split("\n")[1] ?? ""
                const cols = values.split(/\s+/)
                setActive(cols[1] === "disabled" && cols[3] === "disabled")
            })
            .catch(() => { })
    }
    refresh()
    // reflect external changes (keybind, nm-applet): re-check when the
    // wifi radio flips — a free reactive signal, no recurring poll
    const net = AstalNetwork.get_default()
    if (net?.wifi) {
        const unsub = createBinding(net.wifi, "enabled").subscribe(refresh)
        onCleanup(unsub)
    }

    return <DropdownButton
        icon={"airplane-mode-symbolic"}
        label={"Airplane Mode"}
        subtitle={active.as(v => v ? "On" : "Off")}
        isActive={active}
        activate={() => {
            const next = !active.get()
            execAsync(["nmcli", "radio", "all", next ? "off" : "on"])
                .then(() => setActive(next))
                .catch(() => { })
        }}
    />
}
