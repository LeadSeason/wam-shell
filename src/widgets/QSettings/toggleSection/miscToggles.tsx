import { createState } from "gnim";
import { exec, execAsync } from "ags/process";
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
    execAsync(["gsettings", "get", "org.gnome.desktop.interface", "color-scheme"])
        .then(v => setActive(v.includes("prefer-dark")))
        .catch(() => { })

    return <DropdownButton
        icon={"weather-clear-night-symbolic"}
        label={"Dark Style"}
        subtitle={active.as(v => v ? "On" : "Off")}
        isActive={active}
        activate={() => {
            const next = !active.get()
            execAsync([
                "gsettings", "set", "org.gnome.desktop.interface",
                "color-scheme", next ? "prefer-dark" : "default"
            ])
                .then(() => setActive(next))
                .catch(() => { })
        }}
    />
}

export function AirplaneModeButton() {
    if (!has("nmcli")) return <></>
    const [active, setActive] = createState(false)
    execAsync(["nmcli", "radio", "all"])
        .then(v => setActive(v.trim().startsWith("disabled")))
        .catch(() => { })

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
