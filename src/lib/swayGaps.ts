import Sway from "./sway"
import Cache from "./cache";
import i3ipc from "gi://i3ipc?version=1.0";
import CommandRegistry from "./requestHandler";
import Config from "../config";
import { setter } from "ags/gobject"

const sway = Sway.get_default();
const cache = Cache.get_default();
const conn = i3ipc.Connection.new(null)
/**
 * @TODO variable size for gap size, Idk why it's called cacheSize
 * Save gapsSize in 
 */

export default class SwayGaps {
    static instance: SwayGaps
    
    static get_default() {
        if (!this.instance)
            this.instance = new SwayGaps()

        return this.instance
    }

    #gaps: boolean = (cache.data.gaps === undefined) ? false : cache.data.gaps
    #gapSize: number = (cache.data.gapsSize === undefined) ? 10 : cache.data.gapsSize
    
    setGaps(size: number = this.#gapSize) {
        this.#gapSize = size
        sway.message_async(`gaps inner all set ${size}; gaps outer all set ${size}`);

    }

    toggleGaps() {
        this.#gaps = !this.#gaps;
        this.gaps = this.#gaps; // Sets the sway-gap state from wam
        this.notify("gaps")
    }

    set gapSize(size: number) {
        this.#gapSize = size
        this.setGaps(size)
    }
    
    get gapSize(): number {
        return this.#gapSize
    }

    @setter(Boolean)
    set gaps(state: boolean) {
        this.#gaps = state;
        this.setGaps(state ? this.#gapSize : 0)
        cache.data = { gaps: state };
    }
    
    get gaps(): boolean {
        return this.#gaps;
    }

    constructor() {
        super()
        // This 1. loads the form cache, Set the cache 
        this.gaps = this.#gaps
        
        conn.on("workspace", async (conn: i3ipc.Connection, event: i3ipc.WorkspaceEvent) => {
            if (event.change === "init") {
                console.log("New Workspace Init, Setting size...")
                this.setGaps()
            }
        })

        const registry = CommandRegistry.get_default()

        registry.register({
            name: ["toggleGaps"],
            description: "Toggles gaps",
            main: () => {
                this.toggleGaps()
                return `Toggled gaps`
            }
        })

        console.log("SwayGaps init OK")
    }
}

