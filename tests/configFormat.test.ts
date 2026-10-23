import GLib from "gi://GLib?version=2.0"
import { test, eq } from "./framework"
import { formatConfig, type FormatResult } from "../src/lib/configFormat"

const check = (cond: boolean, message: string) => {
    if (!cond) throw new Error(message)
}

const ok = (r: FormatResult): Extract<FormatResult, { ok: true }> => {
    if (!r.ok) throw new Error(`expected ok, got: ${r.error}`)
    return r
}

const readRepo = (path: string): string => {
    const [bytes, data] = GLib.file_get_contents(path)
    check(bytes, `could not read ${path}`)
    return new TextDecoder().decode(data)
}

// a miniature template with the shapes the real one uses: a top-level
// example, a section with prose docs, a compact example block
const MINI = [
    "# intro doc",
    "#",
    "# top_key - a top level key. default 1",
    "# top_key = 1",
    "",
    "# ════════════════════════════════════════════════════════════════════",
    "# Alpha",
    "# ════════════════════════════════════════════════════════════════════",
    "",
    "# [alpha] - the alpha section",
    '# one - first option. default "x"',
    "# two - second option. default false",
    "# [alpha]",
    '# one = "x"',
    "# two = false",
    "",
].join("\n")

test("configFormat: the real template formats to itself", () => {
    const tpl = readRepo("config.toml")
    const r = ok(formatConfig(tpl, tpl))
    eq(r.output, tpl)
    eq(r.stats, { placed: 0, folded: 0, panels: 0, preserved: 0 })
})

test("configFormat: values land at the template's example positions", () => {
    const user = [
        "# my notes, which are dropped",
        "top_key = 7",
        "",
        "[alpha]",
        'one="overridden"',
    ].join("\n")
    const r = ok(formatConfig(MINI, user))
    check(
        r.output.includes("\ntop_key = 7\n") || r.output.startsWith("top_key = 7\n"),
        `top value not in place:\n${r.output}`,
    )
    check(r.output.includes('one = "overridden"'), `value not normalized:\n${r.output}`)
    check(r.output.includes("[alpha]\n"), `section header not uncommented:\n${r.output}`)
    check(r.output.includes('# one = "x"') === false, "set example should be replaced")
    check(r.output.includes("# two = false"), "unset example missing")
    check(!r.output.includes("my notes"), "user comment survived")
    // idempotent
    eq(ok(formatConfig(MINI, r.output)).output, r.output)
})

test("configFormat: a flat spelling folds into its section", () => {
    // a bare top-level `one` belongs to [alpha]: it is the only section
    // reading that name flat
    const user = 'one = "flat"\n'
    const r = ok(formatConfig(MINI, user))
    check(r.output.includes('one = "flat"'), `not folded:\n${r.output}`)
    check(r.output.includes("[alpha]\n"), `alpha header not uncommented:\n${r.output}`)
    eq(r.stats.folded, 1)
})

test("configFormat: the real template folds tray_position and renames", () => {
    const tpl = readRepo("config.toml")
    const user = 'tray_position = "right"\n'
    const r = ok(formatConfig(tpl, user))
    check(r.output.includes("\n[tray]\n"), "tray header not uncommented")
    check(r.output.includes('position = "right"'), `not folded:\n${r.output}`)
    eq(r.stats.folded, 1)
    eq(ok(formatConfig(tpl, r.output)).output, r.output)
})

test("configFormat: a sectionOnly key is not folded, it is preserved", () => {
    const tpl = readRepo("config.toml")
    const r = ok(formatConfig(tpl, "enabled = false\n"))
    check(r.output.includes("Preserved by wam config format"), "no preserved block")
    check(r.output.includes("enabled = false"), "value lost")
    eq(r.stats.folded, 0)
})

test("configFormat: section spelling wins over a flat shadow", () => {
    const tpl = readRepo("config.toml")
    const user = "on_panel = true\n[tray]\non_panel = false\n"
    const r = ok(formatConfig(tpl, user))
    check(r.output.includes("on_panel = false"), "section value lost")
    check(
        !/\non_panel = true\n/.test(r.output.split("Preserved")[0]),
        "flat value leaked into body",
    )
    check(r.output.includes("on_panel = true"), "shadowed value not preserved")
    eq(r.stats.folded, 0)
})

test("configFormat: an ambiguous flat spelling stays at the top level", () => {
    // media and harvest both read bare hide_when_screen_sharing — the
    // reader feeds BOTH from it, so it must not move into either
    const tpl = readRepo("config.toml")
    const r = ok(formatConfig(tpl, "hide_when_screen_sharing = true\n"))
    const head = r.output.split("Preserved")[0]
    check(head.includes("hide_when_screen_sharing = true"), "not kept at the top level")
    check(
        head.indexOf("hide_when_screen_sharing = true") < head.indexOf("# ═"),
        "kept after the first table-opening zone",
    )
    eq(r.stats.folded, 0)
    eq(ok(formatConfig(tpl, r.output)).output, r.output)
})

test("configFormat: unknown keys, sections and known-table strays are preserved", () => {
    const tpl = readRepo("config.toml")
    const user = [
        "legacy_key = 1",
        "",
        "[custom_tool]",
        "enabled = true",
        "",
        "[tray]",
        "bogus = 3",
    ].join("\n")
    const r = ok(formatConfig(tpl, user))
    const tail = r.output.split("Preserved by wam config format")[1]
    check(tail.includes("legacy_key = 1"), "unknown key lost")
    check(tail.includes("[custom_tool]"), "unknown section lost")
    check(tail.includes("enabled = true"), "unknown section content lost")
    // the body never defines [tray] here, so the stray may re-head it
    check(tail.includes("[tray]\n# not a template key\nbogus = 3"), "stray not annotated in place")
    eq(ok(formatConfig(tpl, r.output)).output, r.output)
})

test("configFormat: [[panel]] examples drop when the user has panels", () => {
    const tpl = readRepo("config.toml")
    const user = [
        "[[panel]]",
        'monitors = ["eDP-1"]',
        'position = "bottom"',
        'left = ["workspaces"]',
        "",
        "[[panel]]",
        'monitors = ["DP-2"]',
        'left = ["clock"]',
    ].join("\n")
    const r = ok(formatConfig(tpl, user))
    check(r.output.includes('monitors = ["eDP-1"]'), "first panel lost")
    check(r.output.includes('monitors = ["DP-2"]'), "second panel lost")
    check(!r.output.includes('# monitors = ["Acer"]'), "template example not dropped")
    eq(r.stats.panels, 2)
    eq(ok(formatConfig(tpl, r.output)).output, r.output)
})

test("configFormat: [[panel]] examples stay when the user has none", () => {
    const tpl = readRepo("config.toml")
    const r = ok(formatConfig(tpl, "sway_gaps = false\n"))
    check(r.output.includes('# monitors = ["Acer"]'), "panel example dropped without user panels")
})

test("configFormat: multi-line values survive verbatim", () => {
    const tpl = readRepo("config.toml")
    const user = [
        "[notifications]",
        "popup_providers = [",
        '  "github",',
        '  "todoist",',
        "]",
    ].join("\n")
    const r = ok(formatConfig(tpl, user))
    const block = r.output.slice(r.output.indexOf("[notifications]"))
    check(
        block.includes('popup_providers = [\n  "github",\n  "todoist",\n]'),
        `multi-line value mangled:\n${block}`,
    )
    eq(ok(formatConfig(tpl, r.output)).output, r.output)
})

test("configFormat: dotted keys resolve into their section", () => {
    const tpl = readRepo("config.toml")
    // `tray.spacing` IS [tray].spacing to the reader (smol-toml nests
    // dotted keys), so the formatter files it under [tray]
    const r = ok(formatConfig(tpl, "tray.spacing = 5\n"))
    const tray = r.output.slice(r.output.indexOf("\n[tray]\n"))
    check(tray.includes("spacing = 5"), `dotted key not resolved:\n${tray}`)
    eq(ok(formatConfig(tpl, r.output)).output, r.output)
})

test("configFormat: duplicate template examples collapse to one value", () => {
    // [idle_inhibit] shows command twice (alternative spellings)
    const tpl = readRepo("config.toml")
    const r = ok(formatConfig(tpl, '[idle_inhibit]\ncommand = ["wlinhibit"]\n'))
    const block = r.output.slice(r.output.indexOf("\n[idle_inhibit]\n"))
    eq(block.match(/\ncommand = /g)?.length, 1)
    check(block.includes('command = ["wlinhibit"]'), "value missing")
})

test("configFormat: invalid TOML is refused, not mangled", () => {
    const tpl = readRepo("config.toml")
    const r = formatConfig(tpl, "[tray]\nspacing = 1\nspacing = 2\n")
    check(!r.ok, "duplicate key should refuse")
})

test("configFormat: a realistic drifted config formats cleanly and idempotently", () => {
    const tpl = readRepo("config.toml")
    // the shape wam config sync leaves behind: latest template on top,
    // the user's values appended at the bottom, one per line
    const user = [
        tpl,
        "",
        "# --- your values (preserved by wam config sync) ---",
        "[harvest]",
        "enabled = true",
        'work_start = "08:00"',
        "",
        "[calendar]",
        "remind_popup_seconds = 30",
        "",
        'theme = "gruvbox"',
    ].join("\n")
    const r = ok(formatConfig(tpl, user))
    check(r.output.includes('theme = "gruvbox"'), "top-level value lost")
    const harvestStart = r.output.indexOf("\n[harvest]\n")
    const harvest = r.output.slice(harvestStart, r.output.indexOf("\n[", harvestStart + 1))
    check(harvest.includes("enabled = true"), "harvest value lost")
    check(harvest.includes('work_start = "08:00"'), "harvest work_start lost")
    check(!harvest.includes("# enabled = false"), "harvest example not replaced")
    eq(ok(formatConfig(tpl, r.output)).output, r.output)
})
