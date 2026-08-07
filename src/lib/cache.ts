import { readFile } from "ags/file"
import GObject, { register, getter, setter } from "ags/gobject"
import Config from "../config"
import { isFile } from "./utils"
import { writeFileAtomic } from "./atomicWrite"

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

/**
 * Parse a cache file's contents into a cache record.
 *
 * Pure so the shapes a broken file can take are pinned in tests. The
 * shape check is not paranoia: `JSON.parse("null")` RETURNS null rather
 * than throwing, so a one-byte cache file used to sail past the try and
 * blow up on the `lastSave` read below — inside `Cache.get_default()`,
 * which `SwayGaps` calls from `main()`, so the whole shell failed to
 * build its windows. Anything that is not a plain object is simply no
 * cache.
 *
 * @param raw the file's contents ("" for an empty/unreadable file)
 * @param onError reports a malformed file (the caller logs it)
 */
export function parseCacheData(raw: string, onError?: (e: unknown) => void): cacheType {
    const fallback: cacheType = { lastSave: 0 }
    if (!raw) return fallback
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch (e) {
        onError?.(e)
        return fallback
    }
    // arrays are objects too, and an array cache is just as broken
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        onError?.(new Error(`expected an object, got ${parsed === null ? "null" : typeof parsed}`))
        return fallback
    }
    const data = parsed as cacheType
    if (data.lastSave === undefined) data.lastSave = 0
    return data
}

function getCacheData(): cacheType {
    // Initiate a clean file if it doesn't exist.
    if (!isFile(cacheFile)) {
        const data: cacheType = { lastSave: 0 }
        console.log(`Initialized cache file. Generated a new cache file in ${cacheFile}`)
        saveCacheData(data).catch(logSaveError)
        data.lastSave = Date.now()
        return data
    }

    let rawData = ""
    try {
        rawData = readFile(cacheFile)
    } catch (error) {
        console.log(error)
        return { lastSave: 0 }
    }

    return parseCacheData(rawData, e => console.log(`Error in Cachefile (${cacheFile}): ${e}`))
}

// writes are fire-and-forget; without a handler a failed write is an
// unhandled rejection
const logSaveError = (e: unknown) => console.warn("cache: save failed:", e)

async function saveCacheData(data: cacheType) {
    data.lastSave = Date.now()
    // tmp+rename swap and per-path write serialization (an older
    // payload can't overwrite a newer one) live in writeFileAtomic
    return writeFileAtomic(cacheFile, JSON.stringify(data))
}

@register({ GTypeName: "Cache" })
export default class Cache extends GObject.Object {
    static instance: Cache
    static get_default() {
        if (!this.instance) this.instance = new Cache()

        return this.instance
    }

    #cache: cacheType = getCacheData()

    @getter(Object)
    get data(): cacheType {
        return this.#cache
    }

    @setter(Object)
    set data(data: cacheType) {
        // merge into the existing cache and persist
        Object.assign(this.#cache, data)
        saveCacheData(this.#cache)
            // notify once the merge is persisted so watchers can react
            // through the property system (notify::data)
            .then(() => this.notify("data"))
            .catch(logSaveError)
    }
}

export interface cacheType {
    // self - cache.ts
    lastSave?: number | undefined // Don't change
    // swayGaps.ts
    gaps?: boolean | undefined
    gapsSize?: number | undefined
}
