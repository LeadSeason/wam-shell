import Gdk from "gi://Gdk?version=4.0"
import AstalHyprland from "gi://AstalHyprland?version=0.1"
import { execAsync } from "ags/process"
import Config from "../../../config"
import { createIconResolver } from "../../../lib/appIcon"
import { For, createBinding, createState, onCleanup } from "ags"
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

    const displayName = monitor.get_connector()

    // recompute when the workspace list, the focus, or any workspace's
    // clients change — the workspaces binding alone does not fire when a
    // window opens on an existing (empty, hidden) workspace
    const [hyprlandWorkspacesList, setList] =
        createState<AstalHyprland.Workspace[]>([])
    // per-workspace clients subscriptions; hyprland destroys and
    // recreates workspace objects reusing the same id, so entries must
    // be pruned — a plain Set grows with dead GObjects all session
    const hookedClients = new Map<AstalHyprland.Workspace, () => void>()
    // released when the bar is destroyed (monitor hotplug)
    const disposers: (() => void)[] = []
    onCleanup(() => {
        for (const d of disposers) d()
        for (const unsub of hookedClients.values()) unsub()
    })

    const compute = () => {
        const focused = hyprland.focusedWorkspace
        setList(hyprland.workspaces
            // id < 0 are special workspaces (scratchpad)
            .filter((ws) => ws.id > 0 && ws.monitor?.name === displayName)
            .filter((ws) =>
                !Config.workspaces.hideEmpty ||
                ws.clients.length > 0 ||
                ws.id === focused?.id
            )
            .sort((a, b) => a.id - b.id))
    }

    const hook = (wss: AstalHyprland.Workspace[]) => {
        // prune workspace objects hyprland destroyed
        for (const [ws, unsub] of hookedClients) {
            if (!wss.includes(ws)) {
                unsub()
                hookedClients.delete(ws)
            }
        }
        for (const ws of wss) {
            if (hookedClients.has(ws)) continue
            hookedClients.set(ws, createBinding(ws, "clients").subscribe(compute))
        }
    }

    disposers.push(createBinding(hyprland, "workspaces").subscribe(() => {
        hook(hyprland.workspaces)
        compute()
    }))
    disposers.push(createBinding(hyprland, "focusedWorkspace").subscribe(compute))
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
