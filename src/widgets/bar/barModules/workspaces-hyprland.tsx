import Gdk from "gi://Gdk?version=4.0"
import AstalHyprland from "gi://AstalHyprland?version=0.1"
import { execAsync } from "ags/process"
import Config from "../../../config"
import { createIconResolver } from "../../../lib/appIcon"
import { For, createBinding, createState } from "ags"
import { Gtk } from "ags/gtk4";

export default function HyprlandWs({ monitor }: { monitor: Gdk.Monitor }) {
    const hyprland = AstalHyprland.get_default()
    const resolveAppIcon = createIconResolver(Gtk.IconTheme.get_for_display(monitor.display))

    function clientToIcon(client: AstalHyprland.Client) {
        const icon = resolveAppIcon(client.class)
            ?? resolveAppIcon(client.initialClass)
            ?? "missing-icon"
        return <image iconName={icon} />
    }

    const [displayName, setDisplayName] = createState(monitor.get_connector())
    setTimeout(() => {
        setDisplayName(monitor.get_connector())
    })

    // recompute when the workspace list, the focus, or any workspace's
    // clients change — the workspaces binding alone does not fire when a
    // window opens on an existing (empty, hidden) workspace
    const [hyprlandWorkspacesList, setList] =
        createState<AstalHyprland.Workspace[]>([])
    const hookedClients = new Set<number>()

    const compute = () => {
        const focused = hyprland.focusedWorkspace
        setList(hyprland.workspaces
            // id < 0 are special workspaces (scratchpad)
            .filter((ws) => ws.id > 0 && ws.monitor?.name === displayName.get())
            .filter((ws) =>
                !Config.workspaces.hideEmpty ||
                ws.clients.length > 0 ||
                ws.id === focused?.id
            )
            .sort((a, b) => a.id - b.id))
    }

    const hook = (wss: AstalHyprland.Workspace[]) => {
        for (const ws of wss) {
            if (hookedClients.has(ws.id)) continue
            hookedClients.add(ws.id)
            createBinding(ws, "clients").subscribe(compute)
        }
    }

    createBinding(hyprland, "workspaces").subscribe(() => {
        hook(hyprland.workspaces)
        compute()
    })
    createBinding(hyprland, "focusedWorkspace").subscribe(compute)
    hook(hyprland.workspaces)
    compute()

    return <box cssName={"workspaces"}>
        <For each={hyprlandWorkspacesList}>
            {(workspace) => {
                const focused = createBinding(hyprland, "focusedWorkspace")
                    .as(focusedWs => workspace.id === focusedWs?.id ? ["active"] : [])
                const clients = createBinding(workspace, "clients").as((clients) => {
                    if (!Config.workspaces.collapseIcons) return clients
                    return clients.filter((client, i, arr) =>
                        arr.findIndex((c) => c.class === client.class) === i
                    )
                })
                return (
                    <button
                        cssName={"workspace"}
                        cssClasses={focused}
                        // hyprland 0.55+ only speaks lua dispatch; astal's
                        // workspace.focus() still uses the legacy syntax
                        onClicked={() => execAsync(["hyprctl", "dispatch",
                            `hl.dsp.focus({workspace="${workspace.id}"})`])
                            .catch(e => console.error(e))}
                    >
                        <box>
                            {Config.workspaces.showLabels && <label label={workspace.id.toString()} />}
                            {Config.workspaces.showIcons &&
                                <For each={clients}>
                                    {(client) => clientToIcon(client)}
                                </For>
                            }
                        </box>
                    </button>
                );
            }}
        </For>
    </box>
}
