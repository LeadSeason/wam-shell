import Gdk from "gi://Gdk?version=4.0"
import AstalHyprland from "gi://AstalHyprland?version=0.1"
import { hyprDispatch } from "../../../lib/hyprDispatch"
import Config from "../../../config"
import { createIconResolver } from "../../../lib/appIcon"
import { createScrollStepper, stepThrough } from "../../../lib/scrollStep"
import { matchesPlayingWindow, playingPlayers, playingPulse } from "../../../lib/mpris"
import { connect, disconnect } from "../../../lib/metrics"
import { For, createBinding, createComputed, createState, onCleanup } from "gnim"
import { Gtk } from "ags/gtk4"

export default function HyprlandWs({ monitor }: { monitor: Gdk.Monitor }) {
    const hyprland = AstalHyprland.get_default()
    const resolveAppIcon = createIconResolver(Gtk.IconTheme.get_for_display(monitor.display))

    function clientToIcon(client: AstalHyprland.Client) {
        const icon =
            resolveAppIcon(client.class) ?? resolveAppIcon(client.initialClass) ?? "missing-icon"
        return <image iconName={icon} />
    }

    // connector can be null at construction (monitor still initializing):
    // bind it and recompute when it arrives instead of reading it once
    const displayName = createBinding(monitor, "connector")

    // recompute when the workspace list, the focus, or any workspace's
    // clients change — the workspaces binding alone does not fire when a
    // window opens on an existing (empty, hidden) workspace
    const [hyprlandWorkspacesList, setList] = createState<AstalHyprland.Workspace[]>([])
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
        setList(
            hyprland.workspaces
                // id < 0 are special workspaces (scratchpad)
                .filter(ws => ws.id > 0 && ws.monitor?.name === displayName.get())
                .filter(
                    ws =>
                        !Config.workspaces.hideEmpty ||
                        ws.clients.length > 0 ||
                        ws.id === focused?.id,
                )
                .sort((a, b) => a.id - b.id),
        )
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

    disposers.push(
        createBinding(hyprland, "workspaces").subscribe(() => {
            hook(hyprland.workspaces)
            compute()
        }),
    )
    disposers.push(createBinding(hyprland, "focusedWorkspace").subscribe(compute))
    disposers.push(displayName.subscribe(compute))
    hook(hyprland.workspaces)
    compute()

    // scroll switches to the next/previous workspace ON THIS MONITOR —
    // the same list the bar is showing, so what a notch does is always
    // visible. With hide_empty on that means occupied workspaces only,
    // which is the useful set to walk anyway.
    const step = createScrollStepper()
    const scrollToNeighbour = (dir: -1 | 0 | 1) => {
        const list = hyprlandWorkspacesList.get()
        const focused = list.find(ws => ws.id === hyprland.focusedWorkspace?.id)
        const target = stepThrough(list, focused, dir)
        if (!target) return
        hyprDispatch(`hl.dsp.focus({workspace="${target.id}"})`, [
            "workspace",
            String(target.id),
        ]).catch(e => console.error("workspace scroll:", e))
    }

    // global client list, shared by every workspace's playing-window
    // match (the untitled-track fallback needs the global per-class
    // window count — see matchesPlayingWindow in lib/mpris)
    const allClients = createBinding(hyprland, "clients")

    // hyprland carries urgency as a transient `urgent` signal per
    // client, not a state (sway's IPC exposes it on the workspace, which
    // is what the sway twin binds). Track marked clients by address:
    // focusing the window clears the mark — seeing it IS answering the
    // request — and closed windows are pruned so reused addresses can't
    // resurrect a mark. Per-bar state is fine: the signal is cheap and
    // each bar only draws its own monitor
    const [urgentClients, setUrgentClients] = createState<Set<string>>(new Set())
    const urgentHandler = connect(hyprland, "urgent", (_h, client: AstalHyprland.Client) => {
        const next = new Set(urgentClients.get())
        next.add(client.address)
        setUrgentClients(next)
    })
    disposers.push(() => disconnect(hyprland, urgentHandler))
    disposers.push(
        createBinding(hyprland, "focusedClient").subscribe(() => {
            const focused = hyprland.focusedClient
            if (!focused || !urgentClients.get().has(focused.address)) return
            const next = new Set(urgentClients.get())
            next.delete(focused.address)
            setUrgentClients(next)
        }),
    )
    disposers.push(
        createBinding(hyprland, "clients").subscribe(() => {
            const live = new Set(hyprland.clients.map(c => c.address))
            const current = urgentClients.get()
            if ([...current].every(a => live.has(a))) return
            setUrgentClients(new Set([...current].filter(a => live.has(a))))
        }),
    )

    return (
        <box cssName={"workspaces"}>
            <Gtk.EventControllerScroll
                flags={Gtk.EventControllerScrollFlags.VERTICAL}
                onScroll={(controller, _dx, dy) => {
                    scrollToNeighbour(step(controller, dy))
                    return true
                }}
            />
            <For each={hyprlandWorkspacesList}>
                {workspace => {
                    const focused = createBinding(hyprland, "focusedWorkspace").as(focusedWs =>
                        workspace.id === focusedWs?.id ? ["active"] : [],
                    )
                    const clients = createBinding(workspace, "clients").as(clients => {
                        if (!Config.workspaces.collapseIcons) return clients
                        return clients.filter(
                            (client, i, arr) => arr.findIndex(c => c.class === client.class) === i,
                        )
                    })
                    // the playing client, not every client of the
                    // playing app: a browser has a window on every
                    // other workspace, so the class alone lights them
                    // all — matchesPlayingWindow first requires the
                    // window title to carry the track title, then
                    // falls back to the most recently focused window
                    // of the class (episode titles that never reach
                    // the tab title, background tabs). Matching runs
                    // on the unfiltered list: collapse_icons may have
                    // dropped exactly the window that is playing
                    const playing = createComputed(
                        [createBinding(workspace, "clients"), allClients, playingPlayers],
                        (wsClients, all, ps) => {
                            if (ps.length === 0) return false
                            // focusHistoryID ranks recency: 0 is the
                            // most recently focused
                            const recent = new Map<string, AstalHyprland.Client>()
                            for (const c of all) {
                                const cls = c.class.toLowerCase()
                                const cur = recent.get(cls)
                                if (!cur || c.focusHistoryID < cur.focusHistoryID)
                                    recent.set(cls, c)
                            }
                            return wsClients.some(c =>
                                matchesPlayingWindow(
                                    ps,
                                    c.class,
                                    c.title,
                                    recent.get(c.class.toLowerCase()) === c,
                                ),
                            )
                        },
                    )
                    // highlight the workspace itself: "playing" tints
                    // it, "beat" pulses the tint on the shared
                    // heartbeat (playingPulse in lib/mpris)
                    const classes = createComputed(
                        [focused, playing, playingPulse],
                        (f, p, beat) => [
                            ...f,
                            ...(p && Config.workspaces.playingIndicator
                                ? ["playing", ...(beat ? ["beat"] : [])]
                                : []),
                        ],
                    )
                    // a marked client on this workspace paints the
                    // urgency dot (same .urgent style the sway twin
                    // uses). Unfiltered clients: collapse_icons may
                    // have dropped the very window calling for
                    // attention
                    const urgent = createComputed(
                        [createBinding(workspace, "clients"), urgentClients],
                        (wsClients, marked) =>
                            marked.size > 0 && wsClients.some(c => marked.has(c.address)),
                    )
                    return (
                        <button
                            cssName={"workspace"}
                            cssClasses={classes}
                            // astal's workspace.focus() uses the legacy
                            // syntax, which 0.56 rejects — but the lua
                            // form 0.56 wants does not exist before
                            // 0.55, so send whichever this Hyprland
                            // understands. See lib/hyprDispatch: this
                            // hard-coded the lua form and clicking a
                            // workspace did nothing on older releases
                            onClicked={() =>
                                hyprDispatch(`hl.dsp.focus({workspace="${workspace.id}"})`, [
                                    "workspace",
                                    String(workspace.id),
                                ]).catch(e => console.error("workspace focus:", e))
                            }
                        >
                            <box cssClasses={urgent.as(u => (u ? ["urgent"] : []))}>
                                {Config.workspaces.showLabels && (
                                    <label label={workspace.id.toString()} />
                                )}
                                {Config.workspaces.showIcons && (
                                    <For each={clients}>{client => clientToIcon(client)}</For>
                                )}
                            </box>
                        </button>
                    )
                }}
            </For>
        </box>
    )
}
