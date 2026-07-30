import AstalTray from "gi://AstalTray"
import Config from "../config"

// tray.always_on_panel entries are matched against the SNI Id, title and
// icon name, and as a substring of the tooltip. Substring matching is
// needed for Electron apps, which all report "chrome_status_icon_1" as
// their Id, an empty title and no icon name (e.g. Mullvad VPN -> tooltip
// "Connected. Stockholm, Sweden").
export function isPinned(item: AstalTray.TrayItem): boolean {
    const pinned = Config.tray.alwaysOnPanel
    if (
        pinned.includes(item.get_id()) ||
        pinned.includes(item.get_title()) ||
        pinned.includes(item.iconName)
    ) {
        return true
    }
    const tooltip = item.tooltip_markup
    if (!tooltip) return false
    const lower = tooltip.toLowerCase()
    return pinned.some(entry => entry !== "" && lower.includes(entry.toLowerCase()))
}
