import { createBinding } from "gnim";
import { execAsync } from "ags/process";
import { DropdownButton } from "./ToggleButton";
import AstalNetwork from "gi://AstalNetwork?version=0.1";

export function WiredButton() {
    const wired = AstalNetwork.get_default().wired
    const DS = AstalNetwork.DeviceState

    const subtitle = createBinding(wired, "state").as(state => {
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
    })

    return <DropdownButton
        icon={createBinding(wired, "iconName")}
        label={"Wired"}
        subtitle={subtitle}
        isActive={createBinding(wired, "state").as(s => s === DS.ACTIVATED)}
        activate={() => {
            const device = wired.device
            if (!device) return
            const iface = device.get_iface()
            if (!iface) {
                console.error("Wired toggle: device has no interface name")
                return
            }
            const activated = wired.state === DS.ACTIVATED
            execAsync(["nmcli", "device", activated ? "disconnect" : "connect", iface])
                .catch((e) => console.error(e))
        }}
    />
}
