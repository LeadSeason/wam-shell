// The shutdown registry: where every module's `dispose()` is actually
// called from.
//
// The convention (AGENTS.md) has always been that a lib module owning
// long-lived sources exposes a `dispose()` that tears them down. What it
// lacked was a caller — two dozen of them existed and none ever ran, so
// the teardown code was never executed, never tested and free to rot
// (one of them called `AstalHyprland.get_default()` unconditionally,
// which would have touched a socket that does not exist on sway).
//
// A registry rather than one module importing all of them, because the
// importer would force-load every service at startup — including the
// ones that call `AstalX.get_default()` at import time, which tests
// specifically must not pull in. Registering from inside a module means
// only what the shell actually loaded is torn down, and this file keeps
// zero imports so nothing can cycle through it.
//
// Disposers must be idempotent: `runDisposers()` may be reached twice
// (a shutdown signal after an explicit quit), and most of them already
// are — they null their handles as they go.

type Disposer = () => void

// insertion-ordered, keyed by name so a module re-registering (hot
// reload, a singleton rebuilt) replaces rather than stacks
const disposers = new Map<string, Disposer>()

/**
 * Declare how this module tears itself down.
 *
 * @param name unique key, conventionally the module's own name
 *        ("notifd", "sleepTimer"); re-registering replaces
 * @param dispose must be safe to call twice, and safe to call when the
 *        module never started anything
 */
export function registerDispose(name: string, dispose: Disposer): void {
    disposers.set(name, dispose)
}

/** Registered names, in registration order. For tests and `wam status`. */
export function disposerNames(): string[] {
    return [...disposers.keys()]
}

/**
 * Run every registered disposer, newest first.
 *
 * Reverse order because registration order is import order, which is
 * roughly dependency order: a module that registered later may be built
 * on one that registered earlier, so it comes down first.
 *
 * One failing disposer must not strand the rest — teardown is the last
 * thing that runs, and there is no later pass to pick up what it
 * dropped. The registry is cleared either way, which is also what makes
 * a second call a no-op.
 */
export function runDisposers(): void {
    const entries = [...disposers.entries()].reverse()
    disposers.clear()
    for (const [name, dispose] of entries) {
        try {
            dispose()
        } catch (e) {
            console.warn(`shutdown: ${name}.dispose() failed:`, e)
        }
    }
}
