import GLib from "gi://GLib";
import { readFile, writeFileAsync } from "ags/file";
import GObject, { register, property, getter } from "ags/gobject"
import Config from "../config";
import { isFile } from "./utils";

const cacheFile = Config.cacheFile


/**
 * cache.ts - Caching module.
 *
 * For typescript, for adding new types to the data in the module add the type
 * to cacheType.
 *
 * example usage of module
 * ```ts
 * const cache = Cache.get_default()
 * cache.data = { testData: "Hello world" }
 * console.log(cache.data.testData)
 * ```
 */

// For typescript, for adding new types to the data in the module add the type
// to cacheType.

function getCacheData(): cacheType {
    let data: cacheType = {
        lastSave: 0
    }

    // Initiate a clean file if it doesn't exist.
    if (!isFile(cacheFile)) {
        console.log(`Initialized cache file. Generated a new cache file in ${cacheFile}`)
        saveCacheData(data).catch(logSaveError)
        data.lastSave = Date.now();
        return data
    }

    let rawData = ""
    try {
        rawData = readFile(cacheFile)
    } catch (error) {
        console.log(error)
        return data
    }

    try {
        data = JSON.parse(rawData)
    } catch (e) {
        console.log(`Error in Cachefile (${cacheFile}): ${e}`)
    }

    if (data.lastSave === undefined)
        data.lastSave = 0

    return data
}

// gjs exposes no getpid; the pid comes from procfs so concurrent shell
// instances get distinct tmp names (random fallback still differs)
const pid = (() => {
    try {
        return readFile("/proc/self/stat").split(" ")[0]
    } catch {
        return `${GLib.random_int()}`
    }
})()
let writeCounter = 0

// writes are fire-and-forget; without a handler a failed write is an
// unhandled rejection
const logSaveError = (e: unknown) => console.warn("cache: save failed:", e)

async function saveCacheData(data: cacheType) {
    data.lastSave = Date.now();
    // write to a temp file then swap: a crash mid-write must not leave
    // a truncated cache behind. Unique tmp name per write: every
    // `cache.data = ...` starts an async write, and overlapping writes
    // (slider bursts) must not rename the tmp file out from under a
    // write still in flight
    const tmp = `${cacheFile}.tmp-${pid}-${writeCounter++}`
    await writeFileAsync(tmp, JSON.stringify(data))
    GLib.rename(tmp, cacheFile)
}

@register({ GTypeName: "Cache" })
export default class Cache extends GObject.Object {
    static instance: Cache
    static get_default() {
        if (!this.instance)
            this.instance = new Cache()

        return this.instance
    }

    #cache: cacheType = getCacheData();

    get data(): cacheType {
        return this.#cache;
    }

    set data(data: cacheType) {
        // merge into the existing cache and persist
        Object.assign(this.#cache, data)
        saveCacheData(this.#cache)
            .then(() => {
                /*
            @TODO: Create cacheType constructor so we can notify that the
            data has changed.
            this.notify("data")*/
            })
            .catch(logSaveError)
    }
}

interface cacheType {
    // self - cache.ts
    lastSave?: number | undefined // Don't change
    // swayGaps.ts
    gaps?: boolean | undefined
    gapsSize?: number | undefined
}