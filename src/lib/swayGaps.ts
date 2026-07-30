import GObject from "ags/gobject"
import { register, getter, setter } from "ags/gobject"
import GLib from "gi://GLib?version=2.0"
import i3ipc from "gi://i3ipc?version=1.0"
import Sway from "./sway"
import CommandRegistry from "./requestHandler"
import Cache from "./cache"

@register({ GTypeName: "SwayGaps" })
export default class SwayGaps extends GObject.Object {
    static instance: SwayGaps

    static get_default() {
        if (!this.instance) this.instance = new SwayGaps()

        return this.instance
    }

    #sway = Sway.get_default()
    #cache = Cache.get_default()
    // i3ipc.Connection.new throws on a stale I3SOCK — tolerate it like
    // Sway.ok does, otherwise the QS toggle section dies with us
    #conn: i3ipc.Connection | null = (() => {
        try {
            return i3ipc.Connection.new(null)
        } catch (e) {
            console.warn("swayGaps: no IPC connection:", e)
            return null
        }
    })()

    #gapState: boolean = this.#cache.data.gaps === undefined ? false : this.#cache.data.gaps
    #gapSize: number = this.#cache.data.gapsSize === undefined ? 10 : this.#cache.data.gapsSize
    // Last applied value, Useful for skipping unnecessary operations
    #lastAppliedValue: number = -1
    // debounce source for cache writes (brightness.ts pattern): a
    // slider drag fires per motion event, but the file only needs the
    // settled value — one write once the changes stop
    #writeSource = 0

    @getter(Number)
    get gap_size(): number {
        return this.#gapSize
    }

    @setter(Number)
    set gap_size(size: number) {
        this.#gapSize = Math.floor(size)
        this.notify("gap_size")
        if (this.#writeSource !== 0) GLib.source_remove(this.#writeSource)
        this.#writeSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this.#writeSource = 0
            this.#cache.data = { gapsSize: this.#gapSize }
            return GLib.SOURCE_REMOVE
        })
        this.#applyGaps()
    }

    @getter(Boolean)
    get gap_state(): boolean {
        return this.#gapState
    }

    @setter(Boolean)
    set gap_state(state: boolean) {
        this.#gapState = state
        this.notify("gap_state")
        this.#cache.data = { gaps: this.#gapState }
        this.#applyGaps()
    }

    #applyGaps(force: boolean = false) {
        if (!this.#sway.ok) return
        let size = this.#gapState ? this.#gapSize : 0
        if (size != this.#lastAppliedValue || force) {
            this.#sway.message(`gaps inner all set ${size}; gaps outer all set ${size}`)
            this.#lastAppliedValue = size
        }
    }

    toggleGaps(state: boolean = !this.gap_state) {
        this.gap_state = state
    }

    constructor() {
        super()
        // Ensure that correct state is applied when shell launches
        this.#applyGaps(true)

        this.#conn?.on("workspace", async (conn: i3ipc.Connection, event: i3ipc.WorkspaceEvent) => {
            if (event.change === "init") {
                console.log("New Workspace Init, Setting size...")
                this.#applyGaps(true)
            }
        })

        const registry = CommandRegistry.get_default()

        registry.register({
            name: ["toggleGaps"],
            description: "Toggles gaps",
            main: () => {
                this.toggleGaps()
                return `Toggled gaps: ${this.#gapState}`
            },
        })
    }
}
