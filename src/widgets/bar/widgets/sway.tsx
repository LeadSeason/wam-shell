import Gdk from "gi://Gdk?version=4.0"
import Sway, { Node } from "../../../lib/sway"
import { Accessor, For, With, createBinding } from "ags"
import { Gtk } from "ags/gtk4";
import GObject from "ags/gobject";
import { getInstanceNames } from "ags/app";

function focus_workspace(sway: Sway, ws: any) {
    sway.message_async(
        `mouse_warping output; workspace number ${ws.num}; mouse_warping container`
    );
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
                result.push(...getLeafNodes(child.floating_nodes!));
            }
        } else {
            // It's a leaf — no children or floating nodes
            if (child.type === "con")
                result.push(child);
        }
    }

    return result;
}

function swayNodeToIcon(node: Node) {
    // X11 app
    if (node.shell === "xwayland") {
        let elements = [
            node.window_properties?.class,
            node.window_properties?.instance,
            node.window_properties?.title,
            node.window_properties?.window_role,
            node.window_properties?.window_type
       ]
        for (const element of elements)  {
            if (!element) continue;
            if (new Gtk.IconTheme().lookup_icon((element != null) ? element : "", null, 48, 1, null, null).get_icon_name() !== "image-missing") {
                return <image iconName={element} />
            }
        }
    }
    else {
        // Wayland app
        let elements = [
            node?.app_id,
            (node.name != null) ? node.name.split(" ")[0] : "",
            (node.name != null) ? node.name : ""
        ]
        for (const element of elements) {
            if (!element) continue;
            if (new Gtk.IconTheme().lookup_icon((element != null) ? element : "", null, 48, 1, null, null).get_icon_name() !== "image-missing") {
                return <image iconName={element} />
            }
        }
    }
    // Default image of missing icons
    return <image iconName={"image-missing"} />
}

export default function SwayWs({ monitor }: { monitor: Gdk.Monitor; }) {
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
                    .as((workspaceList) => {
                        const start = Date.now();

                        // 1st find: get the display from tree root
                        // 2nt find: find the correct workspace from outputs workspaces
                        // This is needed because workspaceList doesn't contain the child nodes
                        let workspaceNode = sway.tree.find(i => i.name === displayName)?.nodes.find(i => i.id === workspace.id) as Node
                        // Remove workpaces that failed to find
                        if (workspaceNode == undefined) {
                            return undefined
                        }
                        // Remove workspace without nodes
                        const hasNodes = workspaceNode.nodes && workspaceNode.nodes.length > 0;
                        const hasFloating = workspaceNode.floating_nodes && workspaceNode.floating_nodes.length > 0;
                        if (!(hasNodes || hasFloating)) {
                            return undefined
                        }

                        let nodes = workspaceNode.nodes
                        nodes.push.apply(workspaceNode.floating_nodes)
                        
                        let things = getLeafNodes(nodes)
                        let final = <box $={(self) => {
                            things.forEach(node => {
                                self.append(swayNodeToIcon(node))
                            });
                        }} />

                        const end = Date.now();
                        const elapsedMs = end - start;
                        console.log(`workspace(${workspace.id}) Icon lookup took ${elapsedMs} ms`);
                        return final
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
                                {(value) => value || <box />} 
                            </With>
                        </box>
                    </button>
                );
            }}
        </For>
    </box>
}