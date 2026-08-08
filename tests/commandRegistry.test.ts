import { test, eq, runAsync } from "./framework"
import CommandRegistry from "../src/lib/commandRegistry"
import Config from "../src/config"

// commandRegistry.ts exists in its own module precisely so it can be
// exercised without a display (requestHandler.ts is where the
// app-dependent "quit" lives). It had no test anyway — which is a shame,
// because every request the compositor binds a key to goes through
// execute(), and its argument handling has two documented sharp edges:
// whitespace splitting, and first-match-wins alias resolution.

// a private instance per case: get_default() is a singleton shared with
// whatever else the bundle imported, and registrations are permanent
const fresh = () => new CommandRegistry()

const raw = (r: CommandRegistry, argv: string[]) => {
    let out = ""
    runAsync(r.execute(argv, true).then(s => void (out = s)))
    return out
}

// A DISPATCHED command's reply is prefixed with the instance name; the
// error paths are not. Strip the exact prefix rather than "up to the
// first colon" — an unknown-command reply starts "Unknown request: …",
// which a greedy strip eats the front of
const prefix = `${Config.instanceName}: `
const call = (r: CommandRegistry, argv: string[]) => {
    const out = raw(r, argv)
    eq(out.startsWith(prefix), true, `expected the instance prefix on: ${out}`)
    return out.slice(prefix.length)
}

test("commandRegistry: dispatches to the registered main", () => {
    const r = fresh()
    r.register({ name: ["hello"], main: () => "world" })
    eq(call(r, ["hello"]), "world")
})

test("commandRegistry: every alias resolves, case-insensitively", () => {
    const r = fresh()
    r.register({ name: ["qSettings", "quickSettings"], main: () => "ok" })
    eq(call(r, ["qSettings"]), "ok")
    eq(call(r, ["quicksettings"]), "ok")
    eq(call(r, ["QSETTINGS"]), "ok")
})

test("commandRegistry: arguments arrive split on whitespace", () => {
    // `ags request -i x "sleep-timer 11:30 pm"` delivers the whole
    // string as ONE argv element, and a fixed list arrives as several:
    // both have to end up as the same argument array
    const r = fresh()
    r.register({ name: ["echo"], main: args => args.join("|") })
    eq(call(r, ["echo 11:30 pm"]), "11:30|pm")
    eq(call(r, ["echo", "11:30", "pm"]), "11:30|pm")
    // runs of whitespace collapse rather than producing empty arguments
    eq(call(r, ["echo   a    b  "]), "a|b")
})

test("commandRegistry: no arguments at all is a usage hint, not a crash", () => {
    // not prefixed with the instance name: it never reaches a command
    eq(raw(fresh(), []), "<helper> help for list of commands")
})

test("commandRegistry: an unknown command says so and names itself", () => {
    const r = fresh()
    eq(
        raw(r, ["nosuchthing"]),
        'Unknown request: nosuchthing. Type "help" for a list of commands.',
    )
})

test("commandRegistry: a throwing main is reported, not propagated", () => {
    // a request handler that threw used to take the caller with it; the
    // reply has to come back either way or `ags request` hangs
    const r = fresh()
    r.register({
        name: ["boom"],
        main: () => {
            throw new Error("exploded")
        },
    })
    const out = raw(r, ["boom"])
    eq(out.endsWith("Error: exploded"), true, out)
})

test("commandRegistry: an async main is awaited", () => {
    const r = fresh()
    r.register({ name: ["later"], main: () => Promise.resolve("eventually") })
    eq(call(r, ["later"]), "eventually")
})

test("commandRegistry: a duplicate alias is shadowed by the first registration", () => {
    // execute() takes the FIRST match, so a re-registered name silently
    // wins for the older command. The registry warns; this pins which
    // one actually answers, since the warning is easy to miss in a log
    const r = fresh()
    r.register({ name: ["dup"], main: () => "first" })
    r.register({ name: ["dup"], main: () => "second" })
    eq(call(r, ["dup"]), "first")
})

test("commandRegistry: a name containing a space is rejected at registration", () => {
    // execute() splits on whitespace, so such a name could never be
    // dispatched to — failing loudly at registration beats a command
    // that silently cannot be called
    const r = fresh()
    let threw = false
    try {
        r.register({ name: ["two words"], main: () => "" })
    } catch {
        threw = true
    }
    eq(threw, true)
})

test("commandRegistry: help lists commands and their aliases", () => {
    const r = fresh()
    r.register({
        name: ["thing", "alias"],
        description: "does a thing",
        subCommands: ["reset"],
        main: () => "",
    })
    const all = r.help([])
    eq(all.includes("thing"), true, all)
    eq(all.includes("Aliases: thing, alias"), true, all)
    eq(all.includes("subcommands: reset"), true, all)
})

test("commandRegistry: help for one command, with and without a help section", () => {
    const r = fresh()
    r.register({ name: ["documented"], help: "the long help", main: () => "" })
    r.register({ name: ["bare"], main: () => "" })
    eq(r.help(["documented"]), "documented:\nthe long help")
    eq(r.help(["bare"]).startsWith('Command "bare" has no help'), true)
    eq(r.help(["ghost"]), 'No such command "ghost"')
})
