// Tiny test runner for gjs. No node, no deps: tests are bundled with
// `ags bundle` and run with `gjs -m` (see run.sh). Suites register cases
// with test(); the entry point calls summary() last.
import GLib from "gi://GLib?version=2.0"
import System from "system"

let passed = 0
const failures: string[] = []

/**
 * Drive promises to completion inside a synchronous `test()`.
 *
 * gjs has a main loop but the runner does not run one, so an async
 * module (atomicWrite, seenStore, the secret store) settles nothing
 * unless something spins one. This nests a loop, exactly like
 * metrics-probe.ts does, and rethrows the first rejection so the
 * failure lands on the case that caused it.
 *
 * The timeout is the part worth having: the version of this that lived
 * in atomicWrite.test.ts would hang the whole suite forever if a promise
 * never settled, which is the failure mode async code actually has —
 * and a suite that hangs reports nothing at all, where a suite that
 * fails reports which case and why.
 */
export function runAsync(...promises: Promise<unknown>[]): void {
    const loop = new GLib.MainLoop(null, false)
    let failure: unknown = null
    let settled = false
    const timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ASYNC_TIMEOUT_MS, () => {
        if (!settled) {
            settled = true
            failure = new Error(`timed out after ${ASYNC_TIMEOUT_MS}ms`)
            loop.quit()
        }
        return GLib.SOURCE_REMOVE
    })
    const finish = (e?: unknown) => {
        if (settled) return
        settled = true
        GLib.source_remove(timeout)
        failure = e ?? null
        loop.quit()
    }
    Promise.all(promises).then(
        () => finish(),
        e => finish(e ?? new Error("promise rejected with no reason")),
    )
    loop.run()
    if (failure) throw failure
}

const ASYNC_TIMEOUT_MS = 5000

export function test(name: string, fn: () => void) {
    try {
        fn()
        passed++
        print(`ok   ${name}`)
    } catch (e) {
        failures.push(`${name}\n     ${e}`)
        print(`FAIL ${name}`)
    }
}

export function eq(actual: unknown, expected: unknown, what = "") {
    if (!deepEqual(actual, expected))
        throw new Error(`${what ? `${what}: ` : ""}expected ${fmt(expected)}, got ${fmt(actual)}`)
}

/**
 * Structural equality for assertions.
 *
 * Exported for tests/framework.test.ts, which exists because a
 * comparison that is too permissive fails SILENTLY: it does not break a
 * suite, it stops the suite from being able to break. Every case below
 * used to compare equal to anything of its own kind, because
 * `Object.keys` is empty for all of them:
 *
 *   deepEqual(new Set([1]), new Set([9]))   -> true
 *   deepEqual(new Map([["a",1]]), new Map()) -> true
 *   deepEqual(new Date(0), new Date(1e9))    -> true
 *
 * Sets and Maps are ordinary in this codebase (notifd's arrivals map,
 * youtube's seen store, sleepTimer's muted streams), so any test that
 * reached for one was passing on nothing.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true
    if (typeof a !== typeof b || a === null || b === null) return false
    if (typeof a !== "object") return false

    // an array and a plain object are never the same shape, whatever
    // their indices say ([1] vs {0: 1} matched on keys alone)
    if (Array.isArray(a) !== Array.isArray(b)) return false
    if (Array.isArray(a) && Array.isArray(b))
        return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))

    if (a instanceof Date || b instanceof Date)
        return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()

    // membership, not order: a Set is unordered by definition. O(n²) on
    // deep members, which is free at the sizes assertions deal in
    if (a instanceof Set || b instanceof Set) {
        if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false
        const rest = [...b]
        for (const v of a) {
            const i = rest.findIndex(w => deepEqual(v, w))
            if (i < 0) return false
            rest.splice(i, 1) // one-to-one, so duplicates still have to match
        }
        return true
    }

    // keys by identity (`has`/`get`), which is what Map itself uses —
    // a deep key lookup would be a different container's semantics
    if (a instanceof Map || b instanceof Map) {
        if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false
        for (const [k, v] of a) {
            if (!b.has(k) || !deepEqual(v, b.get(k))) return false
        }
        return true
    }

    const ka = Object.keys(a)
    const kb = Object.keys(b as object)
    return (
        ka.length === kb.length &&
        // the presence check matters: {a: undefined} and {b: undefined}
        // are both length 1, and reading a missing key yields undefined
        ka.every(
            k =>
                Object.prototype.hasOwnProperty.call(b, k) &&
                deepEqual((a as any)[k], (b as any)[k]),
        )
    )
}

const fmt = (v: unknown) => JSON.stringify(v)

export function summary() {
    for (const f of failures) print(`---\n${f}`)
    print(`${passed} passed, ${failures.length} failed`)
    if (failures.length > 0) System.exit(1)
}
