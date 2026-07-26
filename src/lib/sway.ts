import GObject, { getter, register, signal } from "ags/gobject"
import i3ipc from "gi://i3ipc"

@register({ GTypeName: "Sway" })
export default class Sway extends GObject.Object {
    static instance: Sway

    static get_default() {
        if (!this.instance)
            this.instance = new Sway()

        return this.instance
    }

    #i3conn: i3ipc.Connection = i3ipc.Connection.new(null)
    #wss: Node[] = JSON.parse(this.#i3conn.message(i3ipc.MessageType.GET_WORKSPACES, ""));
    #outputs: Displays = JSON.parse(this.#i3conn.message(i3ipc.MessageType.GET_OUTPUTS, ""));
    #root: Node = JSON.parse(this.#i3conn.message(i3ipc.MessageType.GET_TREE, ""));

    @getter(Array)
    get wss () { return this.#wss };

    // Returns the root's children (per-output subtrees), not the root itself
    @getter(Array)
    get tree () { return this.#root.nodes };

    @getter(Array)
    get outputs () { return this.#outputs };

    @getter(Number)
    get focused () {
        return this.#wss.find(ws => ws.focused)?.id ?? 0;
    }

    @getter(Number)
    get urgent() {
        return this.#wss.find(ws => ws.urgent)?.id ?? 0;
    }

    @getter(Array)
    get rename () {
        return this.#wss
    }

    // The sway scratchpad's contents live under a magic "__i3" output's "__i3_scratch" workspace
    get scratchpadNodes(): Node[] {
        return this.tree.find(i => i.name === "__i3")?.nodes.find(i => i.name === "__i3_scratch")?.floating_nodes ?? []
    }

    async message_async (message: string): Promise<Commands> {
        return JSON.parse(this.#i3conn.message(i3ipc.MessageType.COMMAND, message));
    }

    // Emitted when a new workspace is created, for consumers (e.g. SwayGaps)
    // that need to react without opening their own IPC connection
    @signal()
    workspaceInit(): void {}

    #refreshWorkspaces(conn: i3ipc.Connection) {
        // Example json in tmp/swaymsg-get_workspaces.json
        this.#wss = JSON.parse(conn.message(i3ipc.MessageType.GET_WORKSPACES, ""))
    }

    #refreshTree(conn: i3ipc.Connection) {
        // Example json in tmp/swaymsg-get_tree.json
        this.#root = JSON.parse(conn.message(i3ipc.MessageType.GET_TREE, ""))
        this.notify("tree")
    }

    constructor() {
        super()

        this.#i3conn.on("workspace", (conn: i3ipc.Connection, event: i3ipc.WorkspaceEvent) => {
            this.#refreshWorkspaces(conn)
            this.#refreshTree(conn)

            switch (event.change) {
                case "focus":
                    this.notify("focused")
                    this.notify("wss")
                    break;

                case "urgent":
                    this.notify("urgent")
                    break;

                case "rename":
                    this.notify("rename")
                    break;

                case "init":
                    this.workspaceInit()
                    this.notify("wss")
                    break;

                default:
                    this.notify("wss")
                    break;
            }
        });

        this.#i3conn.on("output", (conn: i3ipc.Connection, _event: i3ipc.GenericEvent) => {
            this.#outputs = JSON.parse(conn.message(i3ipc.MessageType.GET_OUTPUTS, ""));
            this.notify("outputs");
        });

        this.#i3conn.on("window", (conn: i3ipc.Connection, _event: i3ipc.WindowEvent) => {
            this.#refreshTree(conn)
        });
    }
}

export type Displays = Node[]

export type Commands = Command[]

export interface Command {
  success: boolean
  parse_error?: boolean
}

export interface Node {
    id: number
    type: "root" | "output" | "con" | "floating_con" | "workspace" | "dockarea"
    orientation: "none" | "horizontal" | "vertical"
    percent: number | null
    urgent: boolean
    marks: string[]
    focused: boolean
    layout: "none" | "splith" | "splitv" | "stacked" | "tabbed" | "dockarea" | "output"
    border: "normal" | "none" | "pixel"
    current_border_width: number
    rect: Rect
    deco_rect: Rect
    window_rect: Rect
    geometry: Rect
    name: string
    // The X11 window ID, or null for Wayland windows / non-leaf nodes
    window: number | null
    nodes: Node[]
    floating_nodes: Node[]
    focus: number[]
    fullscreen_mode: number
    sticky: boolean
    // Only set (non-null) on con/floating_con nodes
    floating: "auto_off" | "auto_on" | "user_off" | "user_on" | null
    scratchpad_state: null | "none" | "fresh" | "changed"
    // con/floating_con only
    pid?: number
    app_id?: string
    shell?: "xdg_shell" | "xwayland"
    window_properties?: WindowProperties
    foreign_toplevel_identifier?: string
    idle_inhibitors?: IdleInhibitors
    inhibit_idle?: boolean
    sandbox_app_id?: string | null
    sandbox_engine?: string | null
    sandbox_instance_id?: string | null
    // output only
    primary?: boolean
    make?: string
    model?: string
    serial?: string
    modes?: Mode[]
    non_desktop?: boolean
    active?: boolean
    dpms?: boolean
    power?: boolean
    scale?: number
    scale_filter?: string
    transform?: string
    adaptive_sync_status?: string
    layer_shell_surfaces?: LayerShellSurface[]
    current_workspace?: string
    current_mode?: CurrentMode
    // Only present on the standalone GET_OUTPUTS reply, not on the tree's output nodes
    subpixel_hinting?: string
    // output and con/floating_con
    max_render_time?: number
    allow_tearing?: boolean
    // workspace only
    num?: number
    output?: string
    representation?: string | null
    // workspace and con/floating_con
    visible?: boolean
}

export interface WindowProperties {
    class: string
    instance: string
    title: string
    transient_from: string | null
    window_role: string
    window_type: string
}

export interface IdleInhibitors {
    application: string
    user: string
}

export interface Mode {
    width: number
    height: number
    refresh: number
    picture_aspect_ratio: string
}

export interface LayerShellSurface {
    namespace: string
    layer: string
    extent: Extent
    effects: LayerShellEffects
}

export interface LayerShellEffects {
    blur: boolean
    blur_ignore_transparent: boolean
    blur_xray: boolean
    corner_radius: number
    shadows: boolean
}

export interface Extent {
    width: number
    height: number
    x: number
    y: number
}

export interface CurrentMode {
    width: number
    height: number
    refresh: number
    picture_aspect_ratio: string
}

export interface Rect {
    x: number
    y: number
    width: number
    height: number
}