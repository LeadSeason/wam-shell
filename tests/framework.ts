// Tiny test runner for gjs. No node, no deps: tests are bundled with
// `ags bundle` and run with `gjs -m` (see run.sh). Suites register cases
// with test(); the entry point calls summary() last.
import System from "system"

let passed = 0
const failures: string[] = []

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

function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true
    if (typeof a !== typeof b || a === null || b === null) return false
    if (Array.isArray(a) && Array.isArray(b))
        return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
    if (typeof a === "object") {
        const ka = Object.keys(a)
        const kb = Object.keys(b as object)
        return ka.length === kb.length && ka.every(k => deepEqual((a as any)[k], (b as any)[k]))
    }
    return false
}

const fmt = (v: unknown) => JSON.stringify(v)

export function summary() {
    for (const f of failures) print(`---\n${f}`)
    print(`${passed} passed, ${failures.length} failed`)
    if (failures.length > 0) System.exit(1)
}
