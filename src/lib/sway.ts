import GObject, { getter, register } from "ags/gobject"
import GLib from "gi://GLib?version=2.0"
import i3ipc from "gi://i3ipc"

@register({ GTypeName: "Sway" })
export default class Sway extends GObject.Object {
    static instance: Sway

    static get_default() {
        if (!this.instance)
            this.instance = new Sway()

        return this.instance
    }

    #i3conn!: i3ipc.Connection // assigned in the constructor's try
    #wss: Node[] = []
    #outputs: Displays = []
    // placeholder only: the real root shape (output/child nodes) exists
    // after the first GET_TREE fetch, until then tree reads see an
    // empty root
    #tree: Node = { nodes: [] } as unknown as Node
    // false when the IPC socket is dead (stale I3SOCK, sway not running)
    ok = false

    @getter(Array)
    get wss () { return this.#wss };

    @getter(Array)
    get tree () { return this.#tree.nodes };

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

    // i3ipc.Connection.message() is synchronous and blocks the main loop
    // for one IPC round-trip. Fine for one-shot commands; the event-driven
    // reads in the constructor are coalesced (50ms) to avoid burst stalls.
    message (message: string): Commands {
        return JSON.parse(this.#i3conn.message(i3ipc.MessageType.COMMAND, message));
    }

    constructor() {
        super()

        try {
            this.#i3conn = i3ipc.Connection.new(null)
            this.#wss = JSON.parse(this.#i3conn.message(i3ipc.MessageType.GET_WORKSPACES, ""));
            this.#outputs = JSON.parse(this.#i3conn.message(i3ipc.MessageType.GET_OUTPUTS, ""));
            this.#tree = JSON.parse(this.#i3conn.message(i3ipc.MessageType.GET_TREE, ""));
            this.ok = true
        } catch (e) {
            console.error("Sway: IPC connection failed:", e)
        }
        if (!this.ok) return

        // i3ipc message() blocks the main loop, so an event per focus
        // change / title update / move used to cost up to 3 blocking
        // round-trips each. Coalesce bursts: one trailing fetch 50ms
        // after the last event reads the current state once.
        const pending = new Set<"ws" | "win" | "out">()
        let fetchSource = 0
        const scheduleFetch = (kind: "ws" | "win" | "out") => {
            pending.add(kind)
            if (fetchSource) return
            fetchSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                fetchSource = 0
                const kinds = new Set(pending)
                pending.clear()
                const conn = this.#i3conn
                try {
                    if (kinds.has("ws")) {
                        this.#wss = JSON.parse(conn.message(i3ipc.MessageType.GET_WORKSPACES, ""));
                        this.notify("wss")
                        this.notify("focused")
                        this.notify("urgent")
                    }
                    if (kinds.has("ws") || kinds.has("win")) {
                        this.#tree = JSON.parse(conn.message(i3ipc.MessageType.GET_TREE, ""));
                        this.notify("tree")
                    }
                    if (kinds.has("ws") || kinds.has("out")) {
                        this.#outputs = JSON.parse(conn.message(i3ipc.MessageType.GET_OUTPUTS, ""));
                        this.notify("outputs")
                    }
                } catch (e) {
                    console.error("Sway: IPC fetch failed:", e)
                }
                return GLib.SOURCE_REMOVE
            })
        }

        this.#i3conn.on("workspace", () => scheduleFetch("ws"))
        this.#i3conn.on("output", () => scheduleFetch("out"))

        // window open/close/move/focus: refresh the tree so workspace
        // icons and hide_empty stay current
        this.#i3conn.on("window", () => scheduleFetch("win"))
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
    orientation: string
    percent: number | null
    urgent: boolean
    marks: string[]
    focused: boolean
    layout: "splith" | "splitv" | "stacked" | "tabbed" | "dockarea" | "output"
    border: "normal" | "none" | "pixel"
    current_border_width: number
    rect: Rect
    deco_rect: Rect
    window_rect: Rect
    geometry: Rect
    name: string
    window: any
    nodes: Node[]
    floating_nodes: Node[]
    focus: number[]
    fullscreen_mode: number
    sticky: boolean
    floating: "root" | "output" | "con" | "floating_con" | "workspace" | "dockarea"
    scratchpad_state: null | "none" | "fresh" | "changed"
    pid?: number
    app_id?: string
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
    max_render_time?: number
    allow_tearing?: boolean
    shell?: "xdg_shell" | "xwayland"
    subpixel_hinting: string
    num: number
    output: string
    representation: string
    visible: boolean
    window_properties?: WindowProperties
}

export interface WindowProperties {
    class: string
    instance: string
    title: string
    transient_from: null
    window_role: string
    window_type: string
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
    effects: any[]
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