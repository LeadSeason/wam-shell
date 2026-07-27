import Gtk from "gi://Gtk?version=4.0"
import AstalApps from "gi://AstalApps"

// WM class names often don't match icon names (e.g. class "brave-browser"
// -> Icon=brave-desktop, class "code" -> Icon=vscode). Resolve icons through
// the astal apps database, falling back to direct theme lookup.
export function createIconResolver(theme: Gtk.IconTheme) {
    const cache = new Map<string, string | null>()
    const apps = new AstalApps.Apps()

    // startup wm class -> icon name, from the app database
    const wmClassMap = new Map<string, string>()
    for (const app of apps.get_list()) {
        const wmClass = app.get_wm_class()
        const icon = app.get_icon_name()
        if (wmClass && icon) wmClassMap.set(wmClass.toLowerCase(), icon)
    }

    function resolveUncached(name: string): string | null {
        const lower = name.toLowerCase()

        // desktop entry by StartupWMClass
        const fromWmClass = wmClassMap.get(lower)
        if (fromWmClass && theme.has_icon(fromWmClass)) return fromWmClass

        // fuzzy query catches entry-id style names ("brave-browser")
        const fromQuery = apps.fuzzy_query(name)[0]?.get_icon_name()
        if (fromQuery && theme.has_icon(fromQuery)) return fromQuery

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
