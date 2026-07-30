import GObject, { register, getter } from "ags/gobject"
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

        const updatesFile = Config.pendingUpdates

        const updatesFileUpdate = async (path: string) => {
            // the daemon swaps the file atomically via mv; a momentary
            // missing/unreadable file (before the first write lands) must
            // not become an unhandled rejection and drop the update cycle
            let v: string
            try {
                v = await readFileAsync(path)
            } catch (e) {
                console.warn("archUpdates: read failed:", e)
                return
            }
            this.#updates = v
            // count non-empty lines (robust to a missing trailing newline)
            this.#updatesNum = v.split(/\r\n|\r|\n/).filter(line => line.trim() !== "").length
            this.notify("updates")
            this.notify("updates-num")
            this.notify("overthreshold")
        }
        if (updatesFile === false) {
            throw new Error("ArchUpdates constructed invoked when no update file is provided")
        }

        updatesFileUpdate(updatesFile)

        monitorFile(updatesFile, async f => {
            updatesFileUpdate(f)
        })
    }
}
