import Gio from "gi://Gio?version=2.0"
import GioUnix from "gi://GioUnix?version=2.0"
import Gtk from "gi://Gtk?version=4.0"

// WM class names often don't match icon names (e.g. class "brave-browser"
// -> Icon=brave-desktop, class "code" -> Icon=vscode). Resolve icons through
// the desktop entry database, falling back to direct theme lookup.
export function createIconResolver(theme: Gtk.IconTheme) {
    const cache = new Map<string, string | null>()

    // startup wm class -> icon name, from all registered desktop entries
    const wmClassMap = new Map<string, string>()
    for (const appInfo of Gio.AppInfo.get_all()) {
        const icon = appInfo.get_icon()?.to_string()
        const wmClass = (appInfo as GioUnix.DesktopAppInfo).get_startup_wm_class?.()
        if (icon && wmClass) wmClassMap.set(wmClass.toLowerCase(), icon)
    }

    function fromDesktopId(name: string): string | null {
        const app = GioUnix.DesktopAppInfo.new(`${name}.desktop`)
        const icon = app?.get_icon()?.to_string() ?? null
        return icon && theme.has_icon(icon) ? icon : null
    }

    function resolveUncached(name: string): string | null {
        const lower = name.toLowerCase()

        // desktop entry by id: "brave-browser" -> brave-browser.desktop
        const fromEntry = fromDesktopId(name) ?? fromDesktopId(lower)
        if (fromEntry) return fromEntry

        // desktop entry by StartupWMClass
        const fromWmClass = wmClassMap.get(lower)
        if (fromWmClass && theme.has_icon(fromWmClass)) return fromWmClass

        // plain theme lookup
        if (theme.has_icon(name)) return name
        if (theme.has_icon(lower)) return lower

        return null
    }

    /** @returns icon name for a wm class / app id, or null */
    return function resolveAppIcon(name: string | null | undefined): string | null {
        if (!name) return null
        if (!cache.has(name)) cache.set(name, resolveUncached(name))
        return cache.get(name)!
    }
}
