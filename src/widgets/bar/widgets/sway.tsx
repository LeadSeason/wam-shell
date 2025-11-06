import Gdk from "gi://Gdk?version=4.0"
import Sway, { Node } from "../../../lib/sway"
import { Accessor, For, With, createBinding } from "ags"
import { Gtk } from "ags/gtk4";
import GObject from "ags/gobject";

function focus_workspace(sway: Sway, ws: any) {
    sway.message_async(
        `mouse_warping output; workspace number ${ws.num}; mouse_warping container`
    );
}

export default function SwayWs({ monitor }: { monitor: Gdk.Monitor; }) {

    const GtkIconTheme = Gtk.IconTheme.get_for_display(monitor.display)

    function isValidIconName(icon: string): boolean {
        return GtkIconTheme.has_icon(icon)
    }

    function swayNodeToIcon(node: Node) {
        let elements = []
        if (node.shell === "xwayland") {
            elements = [
                node.window_properties?.class,
                node.window_properties?.instance,
                node.window_properties?.title,
                node.window_properties?.window_role,
                node.window_properties?.window_type
           ]
        }
        else {
            // Wayland app
            elements = [
                node?.app_id,
                (node.name != null) ? node.name.split(" ")[0] : null,
                (node.name != null) ? node.name : null
            ]
        }
        for (const element of elements) {
            if (!element) continue;
            if (isValidIconName(element)) {
                return <image iconName={element} />
            } else {
            }
        }
        console.log("No icon found for name", (node.shell === "xwayland") ? node.window_properties?.class : node.name)
        // Default image of missing icons
        return <image iconName={"missing-icon"} />
    }

    /**
     * Yeah idk how this works, gpt fixed it for me
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
                    console.log("Floating con", child)
                    console.log("")
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

	// Translate Screen coordinates into display names.
	const displayData = sway.display;
	const monitorWorkarea = monitor.get_geometry();

	const displayName = displayData.find(
		(display) => 
            display.rect.x === monitorWorkarea.x &&
            display.rect.y === monitorWorkarea.y
	)?.name;

    const swayWorkspacesList = createBinding(sway, "wss").as((wss) => {
        return wss.filter((ws) => ws.output === displayName);
    });

    return <box cssName={"workspaces"}>
        <For each={swayWorkspacesList}>
            {(workspace) => {
                const focused = createBinding(sway, "focused")
                    .as(id => workspace.id === id ? ["active"] : [])
                const name = createBinding(sway, "rename")
                    .as((renameWorkspacesList) => {
                        let workspaceName = renameWorkspacesList.find(renameWorkspace => workspace.id === renameWorkspace.id)?.name
                        
                        if (workspaceName) {
                            return workspaceName.split(":")[0] || workspace.id.toString()
                        }

                        return workspace.id.toString()
                    })
                const apps: Accessor<GObject.Object | undefined> = createBinding(sway, "rename")
                    .as((_) => {
                        // 1st find: get the display from tree root
                        // 2nt find: find the correct workspace from outputs workspaces
                        // This is needed because workspaceList doesn't contain the child nodes
                        let workspaceNode = sway.tree.find(i => i.name === displayName)?.nodes.find(i => i.id === workspace.id) as Node
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
                        }}/>
                    }) 
                return (
                    <button
                        cssName={"workspace"}
                        cssClasses={focused}
                        onClicked={() => focus_workspace(sway, workspace)}
                    >
                        <box>
                            <label label={name} />
                            <With value={apps}>
                                {(value) => value } 
                            </With>
                        </box>
                    </button>
                );
            }}
        </For>
    </box>
}