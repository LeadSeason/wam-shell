import Gdk from "gi://Gdk?version=4.0"
import Sway from "../../../lib/sway"
import { For, createBinding } from "ags"

function focus_workspace(sway: Sway, ws: any) {
    sway.message_async(
        `mouse_warping output; workspace number ${ws.num}; mouse_warping container`
    );
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

    return <box>
        <For each={swayWorkspacesList}>
            {(workspace) => {
                const focused = createBinding(sway, "focused")
                    .as(id => workspace.id === id ? "focused" : "")
                const name = createBinding(sway, "rename")
                    .as(renameWorkspacesList => renameWorkspacesList.find(renameWorkspace => workspace.id === renameWorkspace.id)?.name || workspace.id.toString())
                return (
                    <button
                        class={focused}
                        onClicked={() => focus_workspace(sway, workspace)}
                    >
                        <label label={name} />
                    </button>
                );
            }}
        </For>
    </box>
}