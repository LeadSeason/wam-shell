import Gdk from "gi://Gdk?version=4.0"
import Sway, { Node } from "../../../lib/sway"
import Config from "../../../config"
import { createIconResolver } from "../../../lib/appIcon"
import { createScrollStepper, stepThrough } from "../../../lib/scrollStep"
import { matchesPlayingWindow, playingPlayers, playingPulse } from "../../../lib/mpris"
import { Accessor, For, With, createBinding, createComputed, onCleanup } from "gnim"
import { Gtk } from "ags/gtk4"
import GObject from "ags/gobject"

// per-workspace icon-box memo: keyed by workspace id, value is the last
// built box + the icon list it was built from. Lets a focus/title-only
// tree change skip rebuilding every workspace's icons.
const wsIconCache = new Map<number, { key: string; box: Gtk.Box }>()

function focus_workspace(sway: Sway, ws: any) {
    sway.message(`mouse_warping output; workspace number ${ws.num}; mouse_warping container`)
}

export default function SwayWs({ monitor }: { monitor: Gdk.Monitor }) {
    const resolveAppIcon = createIconResolver(Gtk.IconTheme.get_for_display(monitor.display))

    function swayNodeToIconName(node: Node): string {
        let elements = []
        if (node.shell === "xwayland") {
            elements = [
                node.window_properties?.class,
                node.window_properties?.instance,
                node.window_properties?.title,
                node.window_properties?.window_role,
                node.window_properties?.window_type,
            ]

            // Steam app icon lookup
            if (node.window_properties?.instance?.startsWith("steam_app_")) {
                // Replaces "steam_app_" -> "steam_icon_" while keeping the numbers
                elements.push(
                    node.window_properties.instance.replace(/^steam_app_(\d+)$/, "steam_icon_$1"),
                )
            }
        } else {
            // Wayland app
            elements = [
                node?.app_id,
                node.name != null ? node.name.split(" ")[0] : null,
                node.name != null ? node.name : null,
            ]
        }
        for (const element of elements) {
            const icon = resolveAppIcon(element)
            if (icon) return icon
        }
        // Default image of missing icons
        return "missing-icon"
    }

    /**
     * Yeah idk how this works, gpt fixed it for me
     * @param root - i3 tree root, or node with nodes
     * @returns Nodes without any child nodes (basically just apps)
     */
    function getLeafNodes(root: Node[]): Node[] {
        const result: Node[] = []

        for (const child of root) {
            const hasNodes = child.nodes && child.nodes.length > 0
            const hasFloating = child.floating_nodes && child.floating_nodes.length > 0

            if (hasNodes || hasFloating) {
                if (hasNodes) {
                    result.push(...getLeafNodes(child.nodes!))
                }
                if (hasFloating) {
                    result.push(...getLeafNodes(child.floating_nodes!))
                }
            } else {
                if (child.type === "con" || child.type === "floating_con")
                    // Must be con, Not Output
                    result.push(child) // It's a leaf — no children
            }
        }

        return result
    }

    const sway = Sway.get_default()
    // IPC dead (stale socket, sway not running): show nothing
    if (!sway.ok) return <></>

    // the cached boxes are widgets of THIS bar's tree: when the bar is
    // destroyed (monitor hotplug) they die with it, so this instance's
    // entries must be pruned — reusing them in the next bar inserts
    // destroyed widgets
    const cacheKeys = new Set<number>()
    onCleanup(() => {
        for (const id of cacheKeys) wsIconCache.delete(id)
    })

    // connector can be null at construction (monitor still initializing):
    // make it a computed dep so the list recomputes when it arrives
    const displayName = createBinding(monitor, "connector")

    const swayWorkspacesList = createComputed(
        [
            createBinding(sway, "wss"),
            createBinding(sway, "tree"),
            createBinding(sway, "focused"),
            displayName,
        ],
        wss => {
            return wss.filter(ws => {
                if (ws.output !== displayName.get()) return false
                if (!Config.workspaces.hideEmpty) return true
                if (ws.id === sway.focused) return true

                // workspaceList doesn't contain child nodes, look them up in the tree
                const wsNode = sway.tree
                    .find(output => output.name === displayName.get())
                    ?.nodes.find(node => node.id === ws.id)
                if (!wsNode) return true // can't tell, keep it

                return (wsNode.nodes?.length ?? 0) > 0 || (wsNode.floating_nodes?.length ?? 0) > 0
            })
        },
    )

    // dead workspaces must not accumulate cache entries over the bar's
    // lifetime: prune whenever the list recomputes
    const unsubPrune = swayWorkspacesList.subscribe(() => {
        const current = new Set(swayWorkspacesList.get().map(ws => ws.id))
        for (const id of [...cacheKeys]) {
            if (!current.has(id)) {
                wsIconCache.delete(id)
                cacheKeys.delete(id)
            }
        }
    })
    onCleanup(unsubPrune)

    // scroll switches to the next/previous workspace on this output —
    // the same list the bar is showing (see the hyprland twin)
    const step = createScrollStepper()
    const scrollToNeighbour = (dir: -1 | 0 | 1) => {
        const list = swayWorkspacesList.get()
        const focused = list.find(ws => ws.id === sway.focused)
        const target = stepThrough(list, focused, dir)
        if (target) focus_workspace(sway, target)
    }

    return (
        <box cssName={"workspaces"}>
            <Gtk.EventControllerScroll
                flags={Gtk.EventControllerScrollFlags.VERTICAL}
                onScroll={(controller, _dx, dy) => {
                    scrollToNeighbour(step(controller, dy))
                    return true
                }}
            />
            <For each={swayWorkspacesList}>
                {workspace => {
                    const focused = createBinding(sway, "focused").as(id =>
                        workspace.id === id ? ["active"] : [],
                    )
                    const name = createBinding(sway, "wss").as(wss => {
                        let workspaceName = wss.find(ws => workspace.id === ws.id)?.name

                        if (workspaceName) {
                            return workspaceName.split(":")[0] || workspace.id.toString()
                        }

                        return workspace.id.toString()
                    })
                    const apps: Accessor<GObject.Object | undefined> = createBinding(
                        sway,
                        "tree",
                    ).as(_ => {
                        // 1st find: get the display from tree root
                        // 2nt find: find the correct workspace from outputs workspaces
                        // This is needed because workspaceList doesn't contain the child nodes
                        let workspaceNode = sway.tree
                            .find(i => i.name === displayName.get())
                            ?.nodes.find(i => i.id === workspace.id) as Node
                        if (workspaceNode == undefined) return <box /> // Remove workplaces that failed to find

                        // Remove workspace without nodes
                        const hasNodes = workspaceNode.nodes && workspaceNode.nodes.length > 0
                        const hasFloating =
                            workspaceNode.floating_nodes && workspaceNode.floating_nodes.length > 0

                        const leafNodes = [
                            ...(hasNodes ? getLeafNodes(workspaceNode.nodes) : []),
                            ...(hasFloating ? getLeafNodes(workspaceNode.floating_nodes) : []),
                        ]
                        let iconNames = leafNodes.map(swayNodeToIconName)
                        if (Config.workspaces.collapseIcons) {
                            iconNames = [...new Set(iconNames)]
                        }

                        // The tree fires on every focus/title change; rebuilding
                        // the icon box for every workspace each time is wasteful
                        // when the window set is unchanged. Memoize by the
                        // resolved icon list (window class) and reuse the box.
                        const key = iconNames.join("\u0000")
                        const cached = wsIconCache.get(workspace.id)
                        if (cached && cached.key === key) return cached.box
                        const box = (
                            <box
                                cssClasses={createBinding(sway, "wss").as(wss =>
                                    wss.find(ws => ws.id === workspace.id)?.urgent
                                        ? ["urgent"]
                                        : [],
                                )}
                                $={self => {
                                    iconNames.forEach(name => {
                                        self.append((<image iconName={name} />) as Gtk.Widget)
                                    })
                                }}
                            />
                        ) as Gtk.Box
                        wsIconCache.set(workspace.id, { key, box })
                        cacheKeys.add(workspace.id)
                        return box
                    })
                    // the playing leaf, not every leaf of the playing
                    // app (see the hyprland twin): the window title must
                    // carry the track title. sway's tree has no global
                    // focus recency, so the no-title-match fallback
                    // stays conservative: a lone window of the class
                    const playing = createComputed(
                        [createBinding(sway, "tree"), playingPlayers],
                        (_tree, ps) => {
                            if (ps.length === 0) return false
                            const wsNode = sway.tree
                                .find(o => o.name === displayName.get())
                                ?.nodes.find(n => n.id === workspace.id)
                            if (!wsNode) return false
                            const leaves = [
                                ...(wsNode.nodes?.length ? getLeafNodes(wsNode.nodes) : []),
                                ...(wsNode.floating_nodes?.length
                                    ? getLeafNodes(wsNode.floating_nodes)
                                    : []),
                            ]
                            const all = getLeafNodes(sway.tree)
                            const wmOf = (n: Node) =>
                                n.shell === "xwayland" ? n.window_properties?.class : n.app_id
                            return leaves.some(n => {
                                const wm = wmOf(n)
                                if (!wm) return false
                                const count = all.filter(
                                    m => wmOf(m)?.toLowerCase() === wm.toLowerCase(),
                                ).length
                                return matchesPlayingWindow(ps, wm, n.name ?? "", count === 1)
                            })
                        },
                    )
                    // highlight the workspace itself (see the hyprland
                    // twin): "playing" tints, "beat" pulses
                    const classes = createComputed(
                        [focused, playing, playingPulse],
                        (f, p, beat) => [
                            ...f,
                            ...(p && Config.workspaces.playingIndicator
                                ? ["playing", ...(beat ? ["beat"] : [])]
                                : []),
                        ],
                    )
                    return (
                        <button
                            cssName={"workspace"}
                            cssClasses={classes}
                            onClicked={() => focus_workspace(sway, workspace)}
                        >
                            <box>
                                {Config.workspaces.showLabels && <label label={name} />}
                                {Config.workspaces.showIcons && (
                                    <With value={apps}>{value => value}</With>
                                )}
                            </box>
                        </button>
                    )
                }}
            </For>
        </box>
    )
}
