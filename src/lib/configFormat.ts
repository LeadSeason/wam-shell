// Deterministic canonicalizer for wam-shell config files — the engine
// behind `wam config format`.
//
// The repo's config.toml is the exhaustive, fully-commented template:
// every option documented, every option shown as a commented example
// line, sections in a fixed order. User configs are seeded from it and
// then drift — values uncommented in place, appended at the bottom by
// `wam config sync`, keys the current template no longer knows. This
// module rewrites any valid config into the template's shape:
//
//   - sections and keys in template order, template doc comments kept
//     verbatim (they come from the CURRENT template, so a formatted
//     file is also re-synced against it — `wam config sync` in place);
//   - active values uncommented at the template's example position for
//     their key, so a section's values appear as a proper [section]
//     block (the compact example block's `# [section]` header is
//     uncommented when the block receives values);
//   - flat top-level spellings folded into their sections the same way
//     the shell reads them (`tray_position` -> [tray] position), via
//     the FLAT table below; a flat spelling the shell would apply to
//     several sections at once is left alone;
//   - keys the template does not know collected into a clearly marked
//     block at the end instead of being dropped silently;
//   - everything else — spacing, which example lines survive, where a
//     value lands — decided by the template, never by the input, so
//     the same input always produces the same output and formatting an
//     already-formatted file changes nothing.
//
// SAFETY: the rewrite is gated twice. The input must parse with
// smol-toml (a broken file is refused, not mangled), and the output is
// re-parsed and compared against the input for reader-visible state —
// every key the shell actually reads, at the same effective location
// with the same value. Any divergence means the template parser
// misfired, and the format is refused rather than written.
//
// This module is display-free and GJS-free (no gi:// imports, no file
// access — text in, text out) so it bundles under plain esbuild and
// unit-tests directly, the same contract as lib/styleCompile.

import { parse as parseToml } from "smol-toml"

// ── the flat-spelling table ──────────────────────────────────────────
//
// Mirrors the sectionOnly/flatKey choices at the createReader call
// sites in src/config.ts — the reader is where the truth lives; this
// table exists so folding puts a top-level value where the shell would
// READ it, and leaves alone the ones the shell would ignore. Keep the
// two in sync (the prayer_times oneOf lists carry the same mirror
// burden in scripts/wam). The verify pass cannot catch a mistake here —
// it proves input and output agree with EACH OTHER, not with the
// reader — so a config.ts change wants the matching edit in the same
// commit.

/** sections where NO key ever had a top-level spelling */
const SECTION_ONLY_SECTIONS = [
    "screen_share",
    "idle_inhibit",
    "netstats",
    "prayer_times",
    "calendar",
    "github",
    "todoist",
    "protonmail",
    "youtube",
]

/** keys marked sectionOnly in an otherwise-flat section */
const SECTION_ONLY_KEYS: Record<string, string[]> = {
    workspaces: ["enabled"],
    media: ["enabled"],
    sleep_timer: ["enabled", "on_panel"],
    harvest: ["enabled", "on_panel"],
    osd: ["enabled", "brightness"],
    notifications: ["position"],
    bluetooth: ["notifications"],
}

/** section.key -> the top-level spelling, when it differs from the key */
const FLAT_RENAMES: Record<string, string> = {
    "tray.position": "tray_position",
}

// ── template parsing ─────────────────────────────────────────────────

interface RunItem {
    key: string
    /** the template line verbatim, e.g. `# position = "left"` */
    line: string
}

/**
 * A maximal run of consecutive example lines. A bare `# [section]` (or
 * `# [[panel]]`) line heading the run is its header; the header is
 * emitted uncommented when the run receives any value, which is what
 * turns a compact example block into the section's value block. A run
 * with a null header is a top-level example and needs no header work.
 */
interface TemplateRun {
    t: "run"
    scope: string | null
    aot: boolean
    header: string | null
    items: RunItem[]
}

interface TemplateRaw {
    t: "raw"
    lines: string[]
}

type TemplateSegment = TemplateRun | TemplateRaw

interface TemplateDoc {
    segments: TemplateSegment[]
    /** top-level keys that have an example line */
    topLevelKeys: Set<string>
    /** section -> its keys, in first-appearance order */
    sectionKeys: Map<string, Set<string>>
    /** sections mentioned with [[...]] */
    aotSections: Set<string>
}

const BANNER_RE = /^#\s*═+\s*$/
// a section mention NEEDS its brackets — `# [workspaces]` bare (a block
// header) vs `# [workspaces] - prose`. Without the bracket requirement
// every prose line starting with a word would name a section
const MENTION_RE = /^#\s*(\[+)([a-z_][a-z0-9_]*)(\]+)(.*)$/
// `# position = "left"` — the commented example lines everything hinges
// on. Exactly one space after the `#`: example lines sit at the margin,
// wrapped doc prose does not (a continuation like
// `#          offset_fajr = 15. active offsets are …` would otherwise
// pass for an example and move the value's landing spot into prose)
const EXAMPLE_RE = /^# ([a-z_][a-z0-9_]*)\s*=(.*)$/

function parseTemplate(text: string): TemplateDoc {
    const segments: TemplateSegment[] = []
    const topLevelKeys = new Set<string>()
    const sectionKeys = new Map<string, Set<string>>()
    const aotSections = new Set<string>()

    let scope: string | null = null
    let run: TemplateRun | null = null

    const flushRun = () => {
        if (!run) return
        segments.push(run)
        run = null
    }
    const pushRaw = (line: string) => {
        flushRun()
        const last = segments[segments.length - 1]
        if (last && last.t === "raw") last.lines.push(line)
        else segments.push({ t: "raw", lines: [line] })
    }

    for (const line of text.split("\n")) {
        if (BANNER_RE.test(line)) {
            // a banner always opens a fresh zone; top-level keys live
            // only in zones no section has been mentioned in yet
            scope = null
            pushRaw(line)
            continue
        }

        const mention = line.match(MENTION_RE)
        if (mention) {
            const aot = mention[1].length === 2
            const name = mention[2]
            const bare = mention[4].trim() === ""
            scope = name
            if (aot) aotSections.add(name)
            if (bare) {
                // block header — becomes the run's header line
                flushRun()
                run = { t: "run", scope, aot, header: line, items: [] }
            } else {
                pushRaw(line)
            }
            continue
        }

        const example = line.match(EXAMPLE_RE)
        if (example) {
            const key = example[1]
            if (!run) run = { t: "run", scope, aot: false, header: null, items: [] }
            run.items.push({ key, line })
            if (run.scope) {
                if (!sectionKeys.has(run.scope)) sectionKeys.set(run.scope, new Set())
                sectionKeys.get(run.scope)!.add(key)
            } else {
                topLevelKeys.add(key)
            }
            continue
        }

        // anything else — prose, blank, a wrapped doc line — ends the run
        pushRaw(line)
    }
    flushRun()

    return { segments, topLevelKeys, sectionKeys, aotSections }
}

// ── user file parsing ────────────────────────────────────────────────

interface UserEntry {
    /** dotted table path, or null at the top level */
    table: string | null
    key: string
    /** the raw right-hand side, verbatim (may span lines) */
    raw: string
}

interface AotInstance {
    key: string
    raw: string
}

interface UserDoc {
    entries: UserEntry[]
    /** one array per [[table]] instance, in file order */
    aot: Map<string, AotInstance[][]>
}

const KEY_LINE_RE = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/
const TABLE_RE = /^\[([^\]]+)\]$/
const AOT_RE = /^\[\[([^\]]+)\]\]$/

/**
 * Consume the raw value text starting at `first`, pulling continuation
 * lines while brackets remain open or a multi-line string is open.
 * Deliberately a small scanner, not a TOML parser: it only needs to
 * know where a value ENDS so the next key is not eaten as its
 * continuation. Anything it misjudges is caught downstream — the input
 * must parse with smol-toml before anything is written, and the output
 * is re-parsed and compared against the input before it is accepted.
 */
function consumeValue(first: string, next: () => string | null): string {
    const lines = [first]
    let depth = 0
    let inBasic = false // "..."
    let inLiteral = false // '...'
    let multiline: '"' | "'" | null = null

    const scan = (text: string): boolean => {
        // true when the value is complete as of the end of this line
        let i = 0
        while (i < text.length) {
            if (multiline) {
                const delim = multiline === '"' ? '"""' : "'''"
                if (text.startsWith(delim, i)) {
                    multiline = null
                    i += 3
                } else i++
                continue
            }
            const ch = text[i]
            if (inBasic) {
                if (ch === "\\") i += 2
                else {
                    if (ch === '"') inBasic = false
                    i++
                }
                continue
            }
            if (inLiteral) {
                if (ch === "'") inLiteral = false
                i++
                continue
            }
            if (ch === '"') {
                if (text.startsWith('"""', i)) {
                    multiline = '"'
                    i += 3
                } else {
                    inBasic = true
                    i++
                }
                continue
            }
            if (ch === "'") {
                if (text.startsWith("'''", i)) {
                    multiline = "'"
                    i += 3
                } else {
                    inLiteral = true
                    i++
                }
                continue
            }
            if (ch === "#" && depth <= 0) return true // a trailing comment
            if (ch === "[" || ch === "{") depth++
            if (ch === "]" || ch === "}") depth--
            i++
        }
        return depth <= 0 && !inBasic && !inLiteral && !multiline
    }

    let complete = scan(first)
    while (!complete) {
        const line = next()
        if (line === null) break // truncated file; the parse gate will reject
        lines.push(line)
        complete = scan(line)
    }
    return lines.join("\n")
}

function parseUserDoc(text: string): UserDoc {
    const lines = text.split("\n")
    const entries: UserEntry[] = []
    const aot = new Map<string, AotInstance[][]>()
    let table: string | null = null
    let aotTable: string | null = null

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim()
        if (trimmed === "" || trimmed.startsWith("#")) continue

        const aotHeader = trimmed.match(AOT_RE)
        if (aotHeader) {
            aotTable = aotHeader[1].trim()
            if (!aot.has(aotTable)) aot.set(aotTable, [])
            aot.get(aotTable)!.push([])
            continue
        }
        const tableHeader = trimmed.match(TABLE_RE)
        if (tableHeader) {
            table = tableHeader[1].trim()
            aotTable = null
            continue
        }

        const keyLine = trimmed.match(KEY_LINE_RE)
        if (!keyLine) continue // not a TOML line the formatter cares about
        const raw = consumeValue(keyLine[2], () => (i + 1 < lines.length ? lines[++i] : null))

        if (aotTable)
            aot.get(aotTable)![aot.get(aotTable)!.length - 1].push({ key: keyLine[1], raw })
        else {
            // a dotted key IS a table path: `tray.spacing = 5` at the
            // top level is [tray].spacing to the reader (smol-toml
            // nests it), so resolve it to its target table now — leaving
            // it dotted would misfile the value in the preserved pen
            const parts = (table ? table.split(".") : []).concat(keyLine[1].split("."))
            const key = parts.pop()!
            entries.push({ table: parts.length ? parts.join(".") : null, key, raw })
        }
    }

    return { entries, aot }
}

// ── claims: where may a top-level spelling live? ─────────────────────

interface Claim {
    section: string
    key: string
}

function buildClaims(sectionKeys: Map<string, Set<string>>): Map<string, Claim[]> {
    const claims = new Map<string, Claim[]>()
    const add = (flat: string, claim: Claim) => {
        if (!claims.has(flat)) claims.set(flat, [])
        claims.get(flat)!.push(claim)
    }
    for (const [section, keys] of sectionKeys) {
        if (SECTION_ONLY_SECTIONS.includes(section)) continue
        const only = SECTION_ONLY_KEYS[section] ?? []
        for (const key of keys) {
            if (only.includes(key)) continue
            add(FLAT_RENAMES[`${section}.${key}`] ?? key, { section, key })
        }
    }
    return claims
}

// ── formatting ───────────────────────────────────────────────────────

export interface FormatStats {
    /** values emitted at their template slot */
    placed: number
    /** of those, the ones that arrived as flat top-level spellings */
    folded: number
    /** [[panel]] instances emitted */
    panels: number
    /** keys carried into the preserved block */
    preserved: number
}

export type FormatResult =
    { ok: true; output: string; stats: FormatStats } | { ok: false; error: string }

/**
 * A group of keys that cannot be emitted in the body. Bare keys (the
 * top-level unknowns, shadows, ambiguities — and strays of tables the
 * body itself defines) are collected under the reserved
 * `[wam-preserved]` table, because TOML has no way back to the top
 * level once a table header appears: bare lines at the end of the file
 * would join the last-defined table and redefine its keys. Tables the
 * template has no section for keep their own header, which is safe
 * exactly because the body never emits it.
 */
interface PreservedBlock {
    note: string[]
    table: string | null
    aot: boolean
    entries: Array<{ key: string; raw: string }>
}

/** reserved: bare preserved keys live here; unwrapped again on re-read */
const PRESERVED_TABLE = "wam-preserved"

const PRESERVED_BANNER = [
    "# ────────────────────────────────────────────────────────────────────",
    "# Preserved by wam config format",
    "#",
    "# The template does not know these keys: they are obsolete spellings,",
    "# come from a newer wam-shell, or would be read somewhere other than",
    "# where they sat. Nothing reads them from here. Move each one to its",
    "# documented place or delete it — this block is rebuilt on every",
    "# `wam config format`. (wam-preserved is a reserved table name.)",
    "# ────────────────────────────────────────────────────────────────────",
]

export function formatConfig(template: string, user: string): FormatResult {
    // gate 1: the input must BE valid TOML before anything reorders it
    let inputParsed: Record<string, unknown>
    try {
        inputParsed = parseToml(user) as Record<string, unknown>
    } catch (err) {
        return {
            ok: false,
            error: `config is not valid TOML, refusing to format:\n${String(err)}`,
        }
    }

    const tpl = parseTemplate(template)
    const doc = parseUserDoc(user)
    const claims = buildClaims(tpl.sectionKeys)
    const stats: FormatStats = { placed: 0, folded: 0, panels: 0, preserved: 0 }

    // ── slot the user's values ───────────────────────────────────────
    // slotId -> raw value text. Table slots are "table|key", the top
    // level "|key". A valid TOML file cannot double-book a slot (a
    // duplicate table key is a parse error) and the flat/section shadow
    // case is resolved before claiming, so first writer wins.
    const slots = new Map<string, string>()
    const preserved: PreservedBlock[] = []
    const wrapper: Array<{ key: string; raw: string }> = []
    // ambiguous flat spellings: fed to several sections at once by the
    // reader, so they must stay at the top level of the output
    const flatKept: Array<{ key: string; raw: string }> = []
    // contents of a [wam-preserved] pen from a previous format: opaque,
    // re-emitted first so the zone is byte-stable across runs
    const penEntries: Array<{ key: string; raw: string }> = []
    // strays of KNOWN tables wait for the body emission: whether their
    // table may be re-headed in the preserved zone depends on whether
    // the body ended up defining it
    const strays: Array<{ table: string; key: string; raw: string }> = []

    const preserveKey = (key: string, raw: string) => {
        wrapper.push({ key, raw })
    }

    for (const entry of doc.entries) {
        if (entry.table === PRESERVED_TABLE) penEntries.push({ key: entry.key, raw: entry.raw })
    }

    // Section spellings first: the reader resolves `table[key] ??
    // data[flat]`, so the section value wins no matter which spelling
    // came first in the file. A flat spelling met afterwards finds its
    // slot taken and is kept as a visible shadow
    for (const entry of doc.entries) {
        // pen contents are opaque: whatever once landed there stays,
        // never re-classified — a stray that happens to share a name
        // with a real key must not be re-activated by a format
        if (entry.table === PRESERVED_TABLE) continue
        if (entry.table === null) continue
        const keys = tpl.sectionKeys.get(entry.table)
        if (!keys || !keys.has(entry.key)) continue
        slots.set(`${entry.table}|${entry.key}`, entry.raw)
    }

    for (const entry of doc.entries) {
        if (entry.table === PRESERVED_TABLE) continue // opaque, re-emitted verbatim
        if (entry.table !== null) {
            const keys = tpl.sectionKeys.get(entry.table)
            if (!keys) continue // unknown table: kept whole by the pass below
            if (keys.has(entry.key)) continue // slotted above
            // an unknown key of a known table. It cannot be emitted in
            // the body; where it travels instead is decided after the
            // body emission (re-heading the table is only safe when the
            // body did not define it)
            strays.push({ table: entry.table, key: entry.key, raw: entry.raw })
            continue
        }

        if (tpl.topLevelKeys.has(entry.key)) {
            if (!slots.has(`|${entry.key}`)) slots.set(`|${entry.key}`, entry.raw)
            continue
        }

        const found = claims.get(entry.key) ?? []
        if (found.length === 1) {
            const { section, key } = found[0]
            if (slots.has(`${section}|${key}`)) {
                // both spellings present: the section value was slotted
                // above and wins, exactly as the reader's lookup
                // resolves it — the loser is kept, but unread, in the pen
                preserveKey(entry.key, entry.raw)
                continue
            }
            slots.set(`${section}|${key}`, entry.raw)
            stats.folded++
            continue
        }
        // one flat name several sections read: the reader feeds EVERY
        // claiming section from it, so it must stay at the top level —
        // it is re-emitted in the header zone, before any table can be
        // opened. (Anything unread, or dead because the section
        // spelling wins, goes to the pen instead)
        if (found.length > 1) {
            flatKept.push({ key: entry.key, raw: entry.raw })
            continue
        }
        preserveKey(entry.key, entry.raw)
    }

    // whole tables the template has no section for keep their header:
    // the body never emits an unknown header, so no redefinition. One
    // block per [[aot]] instance, one per [table]
    for (const [name, instances] of doc.aot) {
        if (tpl.aotSections.has(name)) continue
        for (const inst of instances) {
            preserved.push({
                note: [`section not in the template`],
                table: name,
                aot: true,
                entries: inst,
            })
        }
    }
    const knownTables = new Set(tpl.sectionKeys.keys())
    for (const table of new Set(
        doc.entries.map(e => e.table).filter((t): t is string => t !== null),
    )) {
        if (table === PRESERVED_TABLE) continue // opaque pen, not a block
        if (knownTables.has(table)) continue
        preserved.push({
            note: ["section not in the template"],
            table,
            aot: false,
            entries: doc.entries
                .filter(e => e.table === table)
                .map(({ key, raw }) => ({ key, raw })),
        })
    }

    // ── emit: the template verbatim, values at their example lines ───

    const out: string[] = []
    const emitted = new Set<string>()
    // tables whose header the body emitted uncommented: a preserved
    // block may not define them again
    const bodyDefines = new Set<string>()
    let aotPlaced = false

    const emitRaw = (prefix: string, raw: string) => {
        const lines = raw.split("\n")
        out.push(prefix + lines[0].trim())
        for (let i = 1; i < lines.length; i++) out.push(lines[i].trimEnd())
    }

    let flatKeptEmitted = false
    for (const seg of tpl.segments) {
        if (seg.t === "raw") {
            // ambiguous flat keys must sit before ANY table header; the
            // first banner opens the first zone that could carry one,
            // so they splice in just above it
            if (flatKept.length > 0 && !flatKeptEmitted) {
                const idx = seg.lines.findIndex(l => BANNER_RE.test(l))
                if (idx >= 0) {
                    flatKeptEmitted = true
                    out.push(...seg.lines.slice(0, idx))
                    out.push("")
                    out.push(
                        "# Kept at the top level by wam config format: several sections",
                        "# read these keys from the top level at once. Moving one into",
                        "# its section would stop the others from seeing it.",
                    )
                    for (const { key, raw } of flatKept) emitRaw(`${key} = `, raw)
                    out.push(...seg.lines.slice(idx))
                    continue
                }
            }
            out.push(...seg.lines)
            continue
        }

        if (seg.aot) {
            const instances = doc.aot.get(seg.scope ?? "") ?? []
            if (instances.length === 0 || aotPlaced) {
                // no user tables: the examples ARE the documentation.
                // Or: a later example block, already superseded
                if (instances.length === 0) {
                    if (seg.header) out.push(seg.header)
                    for (const item of seg.items) out.push(item.line)
                }
                continue
            }
            aotPlaced = true
            for (const inst of instances) {
                if (out.length && out[out.length - 1].trim() !== "") out.push("")
                out.push(`[[${seg.scope}]]`)
                for (const { key, raw } of inst) emitRaw(`${key} = `, raw)
            }
            continue
        }

        // a plain run: header uncommented iff this run receives values
        const valued = seg.items.filter(
            item =>
                slots.has(`${seg.scope ?? ""}|${item.key}`) &&
                !emitted.has(`${seg.scope ?? ""}|${item.key}`),
        )
        if (seg.header) {
            if (seg.scope && valued.length > 0) {
                out.push(`[${seg.scope}]`)
                bodyDefines.add(seg.scope)
            } else {
                out.push(seg.header)
            }
        }
        for (const item of seg.items) {
            const slotId = `${seg.scope ?? ""}|${item.key}`
            const raw = slots.get(slotId)
            if (raw === undefined || emitted.has(slotId)) {
                out.push(item.line) // unset: the commented example stays
                continue
            }
            emitted.add(slotId)
            emitRaw(`${item.key} = `, raw)
        }
    }

    // ── the preserved zone ───────────────────────────────────────────
    // bare keys cannot sit loose at the end of the file: after the
    // body's last table header they would join that table and redefine
    // its keys. They live in the reserved [wam-preserved] table, whose
    // contents are unwrapped back to top-level entries on the next
    // read — so the zone re-classifies identically and formatting twice
    // is the same as formatting once
    for (const stray of strays) {
        // re-heading is only safe when the body did not define the
        // table; otherwise the stray joins the pen, where it is simply
        // an unread key
        if (bodyDefines.has(stray.table)) {
            wrapper.push({ key: stray.key, raw: stray.raw })
        } else {
            preserved.push({
                note: ["not a template key"],
                table: stray.table,
                aot: false,
                entries: [{ key: stray.key, raw: stray.raw }],
            })
        }
    }

    if (penEntries.length > 0 || wrapper.length > 0 || preserved.length > 0) {
        out.push("")
        out.push(...PRESERVED_BANNER)
        if (penEntries.length > 0 || wrapper.length > 0) {
            out.push("")
            out.push(`[${PRESERVED_TABLE}]`)
            for (const { key, raw } of [...penEntries, ...wrapper]) emitRaw(`${key} = `, raw)
        }
        for (const block of preserved) {
            out.push("")
            if (block.table !== null)
                out.push(block.aot ? `[[${block.table}]]` : `[${block.table}]`)
            for (const note of block.note) out.push(`# ${note}`)
            for (const { key, raw } of block.entries) emitRaw(`${key} = `, raw)
        }
    }

    // blank-line hygiene: collapse runs, trim the ends — the output's
    // shape comes from the template, never from how the input happened
    // to be spaced
    const cleaned: string[] = []
    for (const line of out) {
        if (line.trim() === "" && (cleaned.length === 0 || cleaned[cleaned.length - 1] === "")) {
            continue
        }
        cleaned.push(line)
    }
    while (cleaned.length && cleaned[cleaned.length - 1] === "") cleaned.pop()
    const output = cleaned.join("\n") + "\n"

    // gate 2: the output must parse, and must mean the same thing to
    // the shell. A transform the verifier cannot vouch for is refused —
    // wrong beats silent.
    let outputParsed: Record<string, unknown>
    try {
        outputParsed = parseToml(output) as Record<string, unknown>
    } catch (err) {
        return {
            ok: false,
            error: `formatted output failed to parse, refusing to write:\n${String(err)}`,
        }
    }
    const before = stableStringify(readerVisible(inputParsed, tpl, claims))
    const after = stableStringify(readerVisible(outputParsed, tpl, claims))
    if (before !== after) {
        return {
            ok: false,
            error: "formatted output would change what the shell reads, refusing to write",
        }
    }

    stats.placed = emitted.size
    stats.panels = doc.aot.get("panel")?.length ?? 0
    stats.preserved =
        penEntries.length + wrapper.length + preserved.reduce((n, b) => n + b.entries.length, 0)
    return { ok: true, output, stats }
}

// ── the verifier ─────────────────────────────────────────────────────

/**
 * The reader-visible projection of a parsed document: only what the
 * shell actually reads, resolved to its effective location. Flat
 * spellings fold into their section (the section spelling wins, as in
 * createReader's lookup); keys nothing reads are dropped — the
 * preserved block is free to relocate those. [[panel]] instances are
 * compared whole.
 */
function readerVisible(
    doc: Record<string, unknown>,
    tpl: TemplateDoc,
    claims: Map<string, Claim[]>,
): unknown {
    const flat: Record<string, unknown> = {}
    const tables: Record<string, Record<string, unknown>> = {}
    let panel: unknown = []

    const isTable = (v: unknown) =>
        typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date)

    for (const [key, value] of Object.entries(doc)) {
        if (key === PRESERVED_TABLE) continue // the pen: unwrapped below
        if (key === "panel") {
            // a table-valued panel is malformed [[panel]] usage — kept
            // as-is so the verifier refuses a format that would drop it
            panel = value
            continue
        }
        if (isTable(value)) {
            const known = tpl.sectionKeys.get(key)
            const row: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
                // unknown keys of a known table are pruned: nothing
                // reads them, and the body/preserved split relocates
                // them freely
                if (known && !known.has(k)) continue
                row[k] = v
            }
            // a table left empty by that pruning is invisible to the
            // reader (`data[section] ?? {}`): [tray] holding only an
            // unknown key reads exactly like no [tray] at all
            if (Object.keys(row).length > 0) tables[key] = row
        } else {
            flat[key] = value
        }
    }

    const folded: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(flat)) {
        if (tpl.topLevelKeys.has(key)) {
            folded[key] = value
            continue
        }
        const found = claims.get(key) ?? []
        if (found.length === 1) {
            const { section, key: sectionKey } = found[0]
            const t = (tables[section] ??= {})
            if (!(sectionKey in t)) t[sectionKey] = value
            // else: the section spelling wins; the flat one is unread
            continue
        }
        // zero claims: unread, prune. Several claims: the reader feeds
        // EVERY claiming section from the flat value, so it stays
        // exactly where it is
        if (found.length > 1) folded[key] = value
    }

    return { flat: folded, tables, panel }
}

/** deterministic JSON: object keys sorted, indentation flat */
function stableStringify(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
    if (typeof value === "object" && value !== null) {
        if (value instanceof Date) return JSON.stringify(value.toISOString())
        const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
        )
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`
    }
    return JSON.stringify(value) ?? "null"
}
