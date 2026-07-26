import { createState } from "gnim";
import { execAsync } from "ags/process";
import { DropdownButton } from "./ToggleButton";

export function NightLightButton() {
    const [active, setActive] = createState(false)
    execAsync("pgrep -x hyprsunset")
        .then(() => setActive(true))
        .catch(() => { })

    return <DropdownButton
        icon={"night-light-symbolic"}
        label={"Night Light"}
        subtitle={active.as(v => v ? "On" : "Off")}
        isActive={active}
        activate={() => {
            const next = !active.get()
            if (next) {
                execAsync(["hyprsunset", "-t", "4000"]).catch(() => { })
            } else {
                execAsync("pkill -x hyprsunset").catch(() => { })
            }
            setActive(next)
        }}
    />
}

export function DarkStyleButton() {
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
