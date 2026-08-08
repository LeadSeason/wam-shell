import { test, eq } from "./framework"
import { registerDispose, runDisposers, disposerNames } from "../src/lib/lifecycle"

// The registry that finally gives the `dispose()` convention a caller.
// Its guarantees matter more than its size: teardown is the last thing
// that runs, so anything it drops is dropped for good.

test("lifecycle: disposers run in reverse registration order", () => {
    // registration order is import order, which is roughly dependency
    // order — what was built on top comes down first
    const order: string[] = []
    registerDispose("first", () => order.push("first"))
    registerDispose("second", () => order.push("second"))
    registerDispose("third", () => order.push("third"))

    runDisposers()
    eq(order, ["third", "second", "first"])
})

test("lifecycle: one throwing disposer does not strand the rest", () => {
    const order: string[] = []
    registerDispose("early", () => order.push("early"))
    registerDispose("bad", () => {
        throw new Error("teardown failed")
    })
    registerDispose("late", () => order.push("late"))

    runDisposers()
    eq(order, ["late", "early"])
})

test("lifecycle: running twice is a no-op the second time", () => {
    // a shutdown signal can follow an explicit quit; a disposer that ran
    // once must not run against state it already tore down
    let calls = 0
    registerDispose("once", () => calls++)

    runDisposers()
    runDisposers()
    eq(calls, 1)
})

test("lifecycle: re-registering a name replaces rather than stacks", () => {
    const calls: string[] = []
    registerDispose("same", () => calls.push("old"))
    registerDispose("same", () => calls.push("new"))

    runDisposers()
    eq(calls, ["new"])
})

test("lifecycle: names are reported in registration order", () => {
    registerDispose("alpha", () => {})
    registerDispose("beta", () => {})
    eq(disposerNames(), ["alpha", "beta"])
    runDisposers()
    eq(disposerNames(), [])
})
