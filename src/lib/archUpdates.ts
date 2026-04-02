import GObject, { register, getter } from "ags/gobject";
import { monitorFile, readFileAsync } from "ags/file";
import Config from "../config";

@register({ GTypeName: "ArchUpdates" })
export default class ArchUpdates extends GObject.Object {
    static instance: ArchUpdates;

    static get_default() {
        if (!this.instance)
            this.instance = new ArchUpdates();

        return this.instance;
    }

    #updates: string = "";
    // Cannot have Uppercase letter, this.notify wont work if it has uppercase 
    // letters. I know updatesNum would look 76% better.
    #updatesnum: number = 0;

    @getter(String)
    get updates (): string { return this.#updates }

    @getter(Number)
    get updatesnum (): number { return this.#updatesnum }

    @getter(Boolean)
    get overthreshold (): boolean { return this.#updatesnum > Config.updatesThreshold }

    constructor() {
        super();

        const updatesFile = Config.pendingUpdates;

        const updatesFileUpdate = async (path: string) => {
            const v = await readFileAsync(path);
            this.#updates = v;
            this.#updatesnum = v.split(/\r\n|\r|\n/).length - 1;
            this.notify("updates");
            this.notify("updatesnum");  // keep lower-case
            this.notify("overthreshold"); // keep lower-case
        }
        if (updatesFile === false) {
            throw "ArchUpdates constructed invoked when no update file is provided"
        }

        updatesFileUpdate(updatesFile);

        monitorFile(updatesFile, async f => {
            updatesFileUpdate(f);
        })
    }
}
