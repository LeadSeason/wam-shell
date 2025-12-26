import GLib from "gi://GLib";
import { readFile, readFileAsync, writeFile, writeFileAsync } from "ags/file";
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
        saveCacheData(data)
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

async function saveCacheData(data: cacheType) {
    data.lastSave = Date.now();
    // Write to a temporary file then swap them.
    // may cause data corruption if application is closed while writing.
    writeFile(cacheFile, JSON.stringify(data))
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
        let cache = this.#cache;
        // Merge cache and new data
        Object.assign(cache, data)
        if (cache === this.#cache) {
            this.#cache = cache;
            saveCacheData(this.#cache)
            .then(() => {/*
                @TODO: Create cacheType constructor so we can notify that the
                data has changed.
                this.notify("data")*/})
        }
    }
}

interface cacheType {
    // self - cache.ts
    lastSave?: number | undefined // Don't change
    // swayGaps.ts
    gaps?: boolean | undefined
    gapsSize?: number | undefined
}