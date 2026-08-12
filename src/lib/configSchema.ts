// Typed readers for the parsed config file.
//
// config.ts used to hand-roll the same shape ~80 times: a per-section
// `get(key, fallback)` closure, then a per-key `typeof` check, then a
// `console.error` naming the key, then the fallback. That is a lot of
// room for one of them to be written slightly differently from the rest
// — and it also hid the one genuinely tricky rule in the file.
//
// THE FLAT FALLBACK. Historically every key could also be written at the
// top level: `[tray] on_panel = true` and a bare `on_panel = true` mean
// the same thing. That is a compatibility affordance, and it is a
// footgun, because the top level is shared: `on_panel` at the top level
// would leak into `[sleep_timer]` and `[harvest]` too, and `position`
// would collide between `[tray]` and `[workspaces]`. Both were found the
// hard way and fixed with a comment. Here the choice is a parameter with
// a name — `sectionOnly` for keys that must never read the top level,
// `flatKey` for the ones whose top-level spelling differs
// (`tray.position` falls back to `tray_position`, not `position`).
//
// Every reader reports a bad value on stderr and returns the documented
// default: a config typo must never take the shell down, and must never
// silently apply something the user did not write.

/** how a rejected value is reported; injectable so tests can capture */
export type Report = (message: string) => void

const defaultReport: Report = message => console.error(message)

export interface KeyOptions {
    /**
     * never fall back to the top level for this key. Use it whenever the
     * bare name is generic enough that another section might own it
     * (`enabled`, `on_panel`, `position`, `poll_minutes`).
     */
    sectionOnly?: boolean
    /**
     * the top-level spelling, when it differs from the section key.
     * `tray.position` reads `tray_position` at the top level, because a
     * bare `position` belongs to `[workspaces]`.
     */
    flatKey?: string
}

export interface NumberOptions extends KeyOptions {
    /** reject values below this (inclusive) */
    min?: number
    /** reject values above this (inclusive) */
    max?: number
    /** reject zero and below. `min: 0` allows zero; this does not */
    positive?: boolean
    /**
     * clamp UP to this instead of rejecting. For rate floors: a
     * `poll_minutes = 1` on a quota-metered API is a typo we correct,
     * not a value we refuse — refusing would apply the much larger
     * default and look like the key was ignored.
     */
    floor?: number
}

export interface SectionReader {
    /** the raw value, whatever it is (undefined when absent) */
    raw(key: string, opts?: KeyOptions): unknown
    /** any value at all, untyped, with a default. For plain booleans-ish
     *  keys whose historical behaviour is "whatever TOML gave us" */
    any<T>(key: string, fallback: T, opts?: KeyOptions): T
    bool(key: string, fallback: boolean, opts?: KeyOptions): boolean
    num(key: string, fallback: number, opts?: NumberOptions): number
    str(key: string, fallback: string, opts?: KeyOptions & { nonEmpty?: boolean }): string
    /** one of a fixed set of strings */
    oneOf<T extends string>(key: string, allowed: readonly T[], fallback: T, opts?: KeyOptions): T
    /** a list of non-empty strings; non-list rejects, bad entries drop */
    strList(key: string, fallback: string[], opts?: KeyOptions): string[]
}

/**
 * @param data the whole parsed config document
 * @param section the table name (`"tray"`), or "" for top-level keys
 * @param opts.sectionOnly default for every key in this section — the
 *        service sections (`[github]`, `[calendar]`, …) set it, because
 *        none of their key names ever had a top-level spelling
 */
export function createReader(
    data: Record<string, any>,
    section: string,
    opts: { sectionOnly?: boolean; report?: Report } = {},
): SectionReader {
    const table = (section ? data[section] : data) ?? {}
    const report = opts.report ?? defaultReport
    const label = (key: string) => (section ? `${section}.${key}` : key)

    const lookup = (key: string, keyOpts?: KeyOptions): unknown => {
        const own = table[key]
        if (own !== undefined) return own
        // a top-level key is a fallback, never an override
        if (keyOpts?.sectionOnly ?? opts.sectionOnly) return undefined
        if (!section) return undefined
        return data[keyOpts?.flatKey ?? key]
    }

    const reject = (key: string, must: string, got: unknown) => {
        report(`Config "${label(key)}" must be ${must}, got ${JSON.stringify(got) ?? typeof got}`)
    }

    return {
        raw: (key, keyOpts) => lookup(key, keyOpts),

        any<T>(key: string, fallback: T, keyOpts?: KeyOptions): T {
            const v = lookup(key, keyOpts)
            return v === undefined ? fallback : (v as T)
        },

        bool(key, fallback, keyOpts) {
            const v = lookup(key, keyOpts)
            if (v === undefined) return fallback
            if (typeof v !== "boolean") {
                reject(key, "true or false", v)
                return fallback
            }
            return v
        },

        num(key, fallback, keyOpts) {
            const v = lookup(key, keyOpts)
            if (v === undefined) return applyFloor(fallback, keyOpts?.floor)
            if (typeof v !== "number" || !Number.isFinite(v)) {
                reject(key, describeRange(keyOpts), v)
                return fallback
            }
            if (keyOpts?.positive && v <= 0) {
                reject(key, describeRange(keyOpts), v)
                return fallback
            }
            if (keyOpts?.min !== undefined && v < keyOpts.min) {
                reject(key, describeRange(keyOpts), v)
                return fallback
            }
            if (keyOpts?.max !== undefined && v > keyOpts.max) {
                reject(key, describeRange(keyOpts), v)
                return fallback
            }
            return applyFloor(v, keyOpts?.floor)
        },

        str(key, fallback, keyOpts) {
            const v = lookup(key, keyOpts)
            if (v === undefined) return fallback
            if (typeof v !== "string" || (keyOpts?.nonEmpty && v === "")) {
                reject(key, keyOpts?.nonEmpty ? "a non-empty string" : "a string", v)
                return fallback
            }
            return v
        },

        oneOf<T extends string>(
            key: string,
            allowed: readonly T[],
            fallback: T,
            keyOpts?: KeyOptions,
        ): T {
            const v = lookup(key, keyOpts)
            if (v === undefined) return fallback
            if (typeof v !== "string" || !allowed.includes(v as T)) {
                reject(key, allowed.map(a => `"${a}"`).join(" or "), v)
                return fallback
            }
            return v as T
        },

        strList(key, fallback, keyOpts) {
            const v = lookup(key, keyOpts)
            if (v === undefined) return fallback
            if (!Array.isArray(v)) {
                reject(key, "a list of strings", v)
                return fallback
            }
            // a bad ENTRY drops silently rather than failing the list:
            // the user's other entries are still exactly what they asked
            // for, and dropping the lot over one typo is the worse answer
            return v.filter((x: unknown): x is string => typeof x === "string" && x !== "")
        },
    }
}

function applyFloor(value: number, floor?: number): number {
    return floor === undefined ? value : Math.max(value, floor)
}

function describeRange(opts?: NumberOptions): string {
    if (!opts) return "a number"
    const { min, max, positive } = opts
    if (min !== undefined && max !== undefined) return `a number between ${min} and ${max}`
    if (positive) return "a positive number"
    if (min === 0) return "a number >= 0"
    if (min !== undefined) return `a number >= ${min}`
    if (max !== undefined) return `a number <= ${max}`
    return "a number"
}

/**
 * A list of positive numbers, all-or-nothing.
 *
 * Unlike `strList`, one bad entry rejects the whole list: these are
 * preset durations shown as buttons, and silently dropping one leaves a
 * row that is missing an option with nothing to say why.
 */
export function numberList(
    label: string,
    value: unknown,
    fallback: number[],
    report: Report = defaultReport,
): number[] {
    if (value === undefined) return fallback
    if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.some((p: unknown) => typeof p !== "number" || !Number.isFinite(p) || p <= 0)
    ) {
        report(
            `Config "${label}" must be a non-empty list of positive numbers, got ${JSON.stringify(value)}`,
        )
        return fallback
    }
    return value as number[]
}
