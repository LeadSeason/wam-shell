import Gdk from "gi://Gdk?version=4.0"
import Sway, { Node } from "../../../lib/sway"
import { resolveNodeIcon } from "../../../lib/swayIcons"
import { Accessor, For, With, createBinding, createComputed, createState } from "ags"
import { Gtk } from "ags/gtk4";
import GObject from "ags/gobject";

function focus_workspace(sway: Sway, ws: Node) {
    sway.message_async(
        `mouse_warping output; workspace number ${ws.num}; mouse_warping container`
    );
}

export default function SwayWs({ monitor }: { monitor: Gdk.Monitor; }) {

    const GtkIconTheme = Gtk.IconTheme.get_for_display(monitor.display)

    function swayNodeToIcon(node: Node) {
        return <image iconName={resolveNodeIcon(node, GtkIconTheme) ?? "missing-icon"} />
    }

    /**
     * Recursively descends into nodes/floating_nodes, collecting leaf con/floating_con nodes (apps).
     * @param root - i3 tree root, or node with nodes
     * @returns Nodes without any child nodes (basically just apps)
     */
    function getLeafNodes(root: Node[]): Node[] {
        const result: Node[] = [];

        for (const child of root) {
            const hasNodes = child.nodes && child.nodes.length > 0;
            const hasFloating = child.floating_nodes && child.floating_nodes.length > 0;

            if (hasNodes || hasFloating) {
                if (hasNodes) {
                    result.push(...getLeafNodes(child.nodes!));
                }
                if (hasFloating) {
                    result.push(...getLeafNodes(child.floating_nodes!));
                }
            } else {
                if (child.type === "con" || child.type === "floating_con") // Must be con, Not Output
                    result.push(child);  // It's a leaf — no children
            }
        }

        return result;
    }

    const sway = Sway.get_default();

    const [displayName, setDisplayName] = createState(monitor.get_connector())
    setTimeout(() => {
        setDisplayName(monitor.get_connector())
    })

    const swayWorkspacesList = createBinding(sway, "wss").as((wss) => {
        return wss.filter((ws) => ws.output === displayName.peek());
    });

    return <box cssName={"workspaces"}>
        <For each={swayWorkspacesList}>
            {(workspace) => {
                const focusedId = createBinding(sway, "focused")
                const wss = createBinding(sway, "wss")
                const cssClasses = createComputed(() => {
                    const classes: string[] = []
                    if (focusedId() === workspace.id) classes.push("active")
                    if (wss().find(w => w.id === workspace.id)?.visible) classes.push("visible")
                    return classes
                })
                const name = createBinding(sway, "rename")
                    .as((renameWorkspacesList) => {
                        let workspaceName = renameWorkspacesList.find(renameWorkspace => workspace.id === renameWorkspace.id)?.name

                        if (workspaceName) {
                            return workspaceName.split(":")[0] || workspace.id.toString()
                        }

                        return workspace.id.toString()
                    })
                const apps: Accessor<GObject.Object | undefined> = createBinding(sway, "tree")
                    .as((_) => {
                        // 1st find: get the display from tree root
                        // 2nt find: find the correct workspace from outputs workspaces
                        // This is needed because workspaceList doesn't contain the child nodes
                        let workspaceNode = sway.tree.find(i => i.name === displayName.peek())?.nodes.find(i => i.id === workspace.id) as Node
                        if (workspaceNode == undefined)
                            return <box />  // Remove workplaces that failed to find

                        // Remove workspace without nodes
                        const hasNodes = workspaceNode.nodes && workspaceNode.nodes.length > 0;
                        const hasFloating = workspaceNode.floating_nodes && workspaceNode.floating_nodes.length > 0;

                        return <box $={(self) => {
                            if (hasNodes) {
                                getLeafNodes(workspaceNode.nodes).forEach(element => {
                                    self.append(swayNodeToIcon(element) as Gtk.Widget)
                                });
                            }
                            if (hasFloating) {
                                getLeafNodes(workspaceNode.floating_nodes).forEach(element => {
                                    self.append(swayNodeToIcon(element) as Gtk.Widget)
                                });
                            }
                        }} />
                    })
                return (
                    <button
                        cssName={"workspace"}
                        cssClasses={cssClasses}
                        onClicked={() => focus_workspace(sway, workspace)}
                    >
                        <box>
                            <label label={name} />
                            <With value={apps}>
                                {(value) => value}
                            </With>
                        </box>
                    </button>
                );
            }}
        </For>
    </box>
}