// The harness testing itself, which is worth the oddity: a comparison
// that is too permissive does not fail a suite, it stops the suite from
// being ABLE to fail. deepEqual used to answer true for any two Sets,
// Maps or Dates — and Sets and Maps are everyday shapes here (notifd's
// arrivals, youtube's seen store, sleepTimer's muted streams), so a test
// that reached for one was asserting nothing at all.
//
// Every case below is written as a pair: something that must match and
// something that must not. A one-sided test of an equality function is
// exactly how the permissive version passed for so long.
import { test, eq, deepEqual } from "./framework"

const yes = (a: unknown, b: unknown, what: string) => eq(deepEqual(a, b), true, what)
const no = (a: unknown, b: unknown, what: string) => eq(deepEqual(a, b), false, what)

test("framework deepEqual: primitives", () => {
    yes(1, 1, "equal numbers")
    no(1, 2, "different numbers")
    no(1, "1", "number vs string")
    yes(null, null, "null")
    no(null, undefined, "null vs undefined")
    no(null, {}, "null vs object")
    no(0, false, "no coercion")
})

test("framework deepEqual: arrays compare by order and length", () => {
    yes([1, 2, 3], [1, 2, 3], "same")
    no([1, 2, 3], [1, 2], "shorter")
    no([1, 2], [2, 1], "reordered")
    yes([[1], [2]], [[1], [2]], "nested")
    no([[1], [2]], [[1], [3]], "nested differing")
})

test("framework deepEqual: an array is not a plain object", () => {
    no([1], { 0: 1 }, "array vs index-keyed object")
    no({ 0: 1 }, [1], "and the other way round")
})

test("framework deepEqual: objects compare by own keys", () => {
    yes({ a: 1, b: 2 }, { b: 2, a: 1 }, "key order is irrelevant")
    no({ a: 1 }, { a: 1, b: 2 }, "extra key")
    no({ a: 1 }, { a: 2 }, "different value")
    // both length 1, and reading a missing key gives undefined —
    // matched before the presence check
    no({ a: undefined }, { b: undefined }, "different keys, both undefined")
})

test("framework deepEqual: Sets compare by membership", () => {
    yes(new Set([1, 2]), new Set([2, 1]), "unordered")
    no(new Set([1]), new Set([9]), "different members")
    no(new Set([1]), new Set([1, 2]), "different sizes")
    yes(new Set(), new Set(), "both empty")
    no(new Set([1]), new Set(), "one empty")
    yes(new Set([{ a: 1 }]), new Set([{ a: 1 }]), "deep members")
    no(new Set([{ a: 1 }]), new Set([{ a: 2 }]), "deep members differing")
})

test("framework deepEqual: Maps compare by key and value", () => {
    yes(new Map([["a", 1]]), new Map([["a", 1]]), "same")
    no(new Map([["a", 1]]), new Map([["a", 2]]), "different value")
    no(new Map([["a", 1]]), new Map([["b", 1]]), "different key")
    no(new Map([["a", 1]]), new Map(), "different sizes")
    yes(new Map(), new Map(), "both empty")
    yes(new Map([["a", { n: 1 }]]), new Map([["a", { n: 1 }]]), "deep values")
})

test("framework deepEqual: Dates compare by instant", () => {
    yes(new Date(0), new Date(0), "same instant")
    no(new Date(0), new Date(1_000_000), "different instants")
})

test("framework deepEqual: containers of different kinds never match", () => {
    no(new Set([1]), [1], "Set vs array")
    no(new Map([["a", 1]]), { a: 1 }, "Map vs object")
    no(new Set(), new Map(), "Set vs Map")
    no(new Date(0), {}, "Date vs object")
})
