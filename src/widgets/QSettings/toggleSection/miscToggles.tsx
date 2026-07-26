import { Accessor, Setter, createState } from "gnim";
import { execAsync } from "ags/process";
import { DropdownButton } from "./ToggleButton";

interface toggleProps {
    activeDropdown: Accessor<number>
    setActiveDropdown: Setter<number>
    dropdownIndex: number
}

export function NightLightButton({
    activeDropdown: activeDropdown,
    setActiveDropdown: setActiveDropdown,
    dropdownIndex: dropdownIndex
}: toggleProps) {
    const [active, setActive] = createState(false)
    execAsync("pgrep -x hyprsunset")
        .then(() => setActive(true))
        .catch(() => { })

    return <DropdownButton
        activeDropdown={activeDropdown}
        setActiveDropdown={setActiveDropdown}
        dropdownIndex={dropdownIndex}
        hasDropdown={false}
        icon={"night-light-symbolic"}
        label={"Night Light"}
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

export function DarkStyleButton({
    activeDropdown: activeDropdown,
    setActiveDropdown: setActiveDropdown,
    dropdownIndex: dropdownIndex
}: toggleProps) {
    const [active, setActive] = createState(false)
    execAsync(["gsettings", "get", "org.gnome.desktop.interface", "color-scheme"])
        .then(v => setActive(v.includes("prefer-dark")))
        .catch(() => { })

    return <DropdownButton
        activeDropdown={activeDropdown}
        setActiveDropdown={setActiveDropdown}
        dropdownIndex={dropdownIndex}
        hasDropdown={false}
        icon={"weather-clear-night-symbolic"}
        label={"Dark Style"}
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

export function AirplaneModeButton({
    activeDropdown: activeDropdown,
    setActiveDropdown: setActiveDropdown,
    dropdownIndex: dropdownIndex
}: toggleProps) {
    const [active, setActive] = createState(false)
    execAsync(["nmcli", "radio", "all"])
        .then(v => setActive(v.trim().startsWith("disabled")))
        .catch(() => { })

    return <DropdownButton
        activeDropdown={activeDropdown}
        setActiveDropdown={setActiveDropdown}
        dropdownIndex={dropdownIndex}
        hasDropdown={false}
        icon={"airplane-mode-symbolic"}
        label={"Airplane Mode"}
        isActive={active}
        activate={() => {
            const next = !active.get()
            execAsync(["nmcli", "radio", "all", next ? "off" : "on"])
                .then(() => setActive(next))
                .catch(() => { })
        }}
    />
}
