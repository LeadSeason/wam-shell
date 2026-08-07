import GObject, { register, getter } from "ags/gobject"
import Gio from "gi://Gio?version=2.0"
import { monitorFile, readFileAsync } from "ags/file"
import Config from "../config"

@register({ GTypeName: "ArchUpdates" })
export default class ArchUpdates extends GObject.Object {
    static instance: ArchUpdates

    static get_default() {
        if (!this.instance) this.instance = new ArchUpdates()

        return this.instance
    }

    #updates: string = ""
    // camelCase is fine: registration kebabifies the getter name, so the
    // property is "updates-num" and notify works
    #updatesNum: number = 0
    #monitor: Gio.FileMonitor | null = null

    @getter(String)
    get updates(): string {
        return this.#updates
    }

    @getter(Number)
    get updatesNum(): number {
        return this.#updatesNum
    }

    @getter(Boolean)
    get overthreshold(): boolean {
        return this.#updatesNum > Config.updatesThreshold
    }

    constructor() {
        super()

        // the PATH, not the "does it exist" answer: the daemon writes
        // the file atomically via mv, and may not have written it at
        // all yet (it starts alongside the shell). A monitor on a
        // missing file still reports its creation, so a late daemon
        // fills the widget in instead of needing a shell restart.
        //
        // This used to throw when there was no file, which made the
        // class unconstructable in exactly the state it is designed to
        // report on — an empty one
        const updatesFile = Config.pendingUpdatesPath

        const updatesFileUpdate = async (path: string) => {
            // the daemon swaps the file atomically via mv; a momentary
            // missing/unreadable file (before the first write lands) must
            // not become an unhandled rejection and drop the update cycle
            let v: string
            try {
                v = await readFileAsync(path)
            } catch (e) {
                // also the ordinary "not written yet" case, so this is
                // a debug note rather than a warning
                console.log("archUpdates: no update list yet:", e)
                return
            }
            this.#updates = v
            // count non-empty lines (robust to a missing trailing newline)
            this.#updatesNum = v.split(/\r\n|\r|\n/).filter(line => line.trim() !== "").length
            this.notify("updates")
            this.notify("updates-num")
            this.notify("overthreshold")
        }
        updatesFileUpdate(updatesFile)

        this.#monitor = monitorFile(updatesFile, async f => {
            updatesFileUpdate(f)
        })
    }

    // convention for lib modules with long-lived sources (see AGENTS.md)
    dispose() {
        this.#monitor?.cancel()
        this.#monitor = null
    }
}
