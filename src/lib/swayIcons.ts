import Gtk from "gi://Gtk?version=4.0"
import { Node } from "./sway"

/**
 * Ordered list of candidate icon names for a sway/i3 node: xwayland apps try
 * their window_properties (plus a steam_app_* -> steam_icon_* remap), while
 * wayland apps fall back to app_id/name.
 */
export function getIconCandidates(node: Node): string[] {
    const candidates: (string | undefined)[] = node.shell === "xwayland"
        ? [
            node.window_properties?.class,
            node.window_properties?.instance,
            node.window_properties?.title,
            node.window_properties?.window_role,
            node.window_properties?.window_type,
            node.window_properties?.instance.startsWith("steam_app_")
                ? node.window_properties.instance.replace(/^steam_app_(\d+)$/, "steam_icon_$1")
                : undefined,
        ]
        : [
            node.app_id,
            node.name?.split(" ")[0],
            node.name,
        ]

    return candidates.filter((candidate): candidate is string => !!candidate)
}

/** Returns the first candidate icon name that exists in the given theme, if any. */
export function resolveNodeIcon(node: Node, theme: Gtk.IconTheme): string | undefined {
    return getIconCandidates(node).find(name => theme.has_icon(name))
}
