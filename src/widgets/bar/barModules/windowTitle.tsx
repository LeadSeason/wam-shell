import { Gtk, Gdk } from "ags/gtk4"
import AstalHyprland from "gi://AstalHyprland"
import Pango from "gi://Pango?version=1.0"
import { With, createBinding } from "gnim"
import Config from "../../../config"
import Sway, { Node } from "../../../lib/sway"
import { createIconResolver } from "../../../lib/appIcon"

// Active window title: app icon + the focused window's title,
// ellipsized. Hyprland uses focusedClient; sway/i3 walks the IPC tree
// for the focused leaf.

function hyprlandTitle(resolveAppIcon: (name: string | null | undefined) => string | null) {
    const hyprland = AstalHyprland.get_default()
    const client = createBinding(hyprland, "focusedClient")
    const iconName = client.as(c => (c ? (resolveAppIcon(c.class) ?? "missing-icon") : ""))
    return (
        <With value={client.as(c => c !== null)}>
            {present =>
                present && (
                    <box cssClasses={["windowTitle"]} spacing={6}>
                        <image iconName={iconName} pixelSize={16} valign={Gtk.Align.CENTER} />
                        <label
                            label={client.as(c => c?.title ?? "")}
                            tooltipText={client.as(c => c?.title ?? "")}
                            xalign={0}
                            maxWidthChars={40}
                            ellipsize={Pango.EllipsizeMode.END}
                        />
                    </box>
                )
            }
        </With>
    ) as Gtk.Widget
}

// the focused leaf of the sway tree, null when none. Two traps:
// sway.tree is the ARRAY of output nodes, and containers on the
// focus path (output, workspace) are flagged focused too — descend
// first; the focused node with no focused children is the window
function focusedLeaf(node: Node): Node | null {
    for (const child of [...(node.nodes ?? []), ...(node.floating_nodes ?? [])]) {
        const found = focusedLeaf(child)
        if (found) return found
    }
    return node.focused && (node.type === "con" || node.type === "floating_con") ? node : null
}

function swayTitle(resolveAppIcon: (name: string | null | undefined) => string | null) {
    const sway = Sway.get_default()
    // IPC dead (stale socket, sway not running): show nothing
    if (!sway.ok) return (<></>) as Gtk.Widget

    const tree = createBinding(sway, "tree")
    const leaf = tree.as(nodes => {
        for (const n of nodes) {
            const f = focusedLeaf(n)
            if (f) return f
        }
        return null
    })
    const iconName = leaf.as(l => {
        if (!l) return ""
        const icon = resolveAppIcon(l.app_id) ?? resolveAppIcon(l.window_properties?.class)
        return icon ?? "missing-icon"
    })
    return (
        <With value={leaf.as(l => l !== null)}>
            {present =>
                present && (
                    <box cssClasses={["windowTitle"]} spacing={6}>
                        <image iconName={iconName} pixelSize={16} valign={Gtk.Align.CENTER} />
                        <label
                            label={leaf.as(l => l?.name ?? "")}
                            tooltipText={leaf.as(l => l?.name ?? "")}
                            xalign={0}
                            maxWidthChars={40}
                            ellipsize={Pango.EllipsizeMode.END}
                        />
                    </box>
                )
            }
        </With>
    ) as Gtk.Widget
}

export default function WindowTitle({ monitor }: { monitor: Gdk.Monitor }) {
    const theme = Gtk.IconTheme.get_for_display(monitor.display)
    const resolveAppIcon = createIconResolver(theme)
    if (Config.desktopSession === "hyprland") return hyprlandTitle(resolveAppIcon)
    if (Config.desktopSession === "sway" || Config.desktopSession === "i3")
        return swayTitle(resolveAppIcon)
    return <></>
}
