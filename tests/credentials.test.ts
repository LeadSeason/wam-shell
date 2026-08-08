import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { test, eq } from "./framework"
import { warnPerms, loadEnvFile, loadCredentials } from "../src/lib/credentials"

const TMP = GLib.getenv("WAM_TEST_TMP")!

let seq = 0
function writeEnv(contents: string, mode = 0o600): string {
    const path = `${TMP}/creds-${seq++}.env`
    GLib.file_set_contents(path, contents)
    Gio.File.new_for_path(path).set_attribute_uint32(
        "unix::mode",
        mode,
        Gio.FileQueryInfoFlags.NONE,
        null,
    )
    return path
}

// run fn with the given env vars set (null = unset), restoring the
// previous state afterwards — tests must never leak env into other suites
function withEnv(vars: Record<string, string | null>, fn: () => void) {
    const saved: Record<string, string | null> = {}
    for (const k of Object.keys(vars)) {
        saved[k] = GLib.getenv(k)
        if (vars[k] === null) GLib.unsetenv(k)
        else GLib.setenv(k, vars[k]!, true)
    }
    try {
        fn()
    } finally {
        for (const k of Object.keys(saved)) {
            if (saved[k] === null) GLib.unsetenv(k)
            else GLib.setenv(k, saved[k]!, true)
        }
    }
}

// NOTE: console.warn is a non-writable, non-configurable property in
// gjs and replacing GLib's log writer aborts the process — warning
// output can't be captured in-process, so warnPerms is covered with
// smoke calls (every branch, no throw) rather than message assertions

const A = "WAM_TEST_CREDS_A"
const B = "WAM_TEST_CREDS_B"

test("loadEnvFile: plain KEY=value pairs", () => {
    const path = writeEnv(`${A}=alpha\n${B}=beta\n`)
    eq(loadEnvFile(path, [A, B]), { [A]: "alpha", [B]: "beta" })
})

test("loadEnvFile: single and double quotes stripped", () => {
    const path = writeEnv(`${A}="double quoted"\n${B}='single quoted'\n`)
    eq(loadEnvFile(path, [A, B]), { [A]: "double quoted", [B]: "single quoted" })
})

test("loadEnvFile: full-line and inline comments ignored", () => {
    const path = writeEnv(`# a comment\n${A}=alpha # trailing\n   # indented\n${B}=beta\n`)
    eq(loadEnvFile(path, [A, B]), { [A]: "alpha", [B]: "beta" })
    // a # NOT preceded by whitespace is part of the value
    const hash = writeEnv(`${A}=al#pha\n`)
    eq(loadEnvFile(hash, [A]), { [A]: "al#pha" })
})

test("loadEnvFile: quotes protect a # inside the value", () => {
    // The two features used to be applied in the wrong order — comment
    // stripping first, then quote removal — so a quoted secret with a
    // " #" in it was silently truncated and the provider failed to
    // authenticate with nothing in the log to say why. Shell semantics:
    // inside quotes, a # is just a character.
    const path = writeEnv(`${A}="p@ss #1"\n${B}='another #2 here'\n`)
    eq(loadEnvFile(path, [A, B]), { [A]: "p@ss #1", [B]: "another #2 here" })
})

test("loadEnvFile: anything after a closing quote is dropped", () => {
    const path = writeEnv(`${A}="value" # a trailing comment\n`)
    eq(loadEnvFile(path, [A]), { [A]: "value" })
})

test("loadEnvFile: a quote inside an unquoted value is left alone", () => {
    const path = writeEnv(`${A}=pa'ss\n`)
    eq(loadEnvFile(path, [A]), { [A]: "pa'ss" })
})

test("loadEnvFile: an unterminated quote keeps the lenient old behaviour", () => {
    // malformed, and not worth inventing a meaning for: strip the
    // comment, drop the stray quote, move on
    const path = writeEnv(`${A}="unterminated\n`)
    eq(loadEnvFile(path, [A]), { [A]: "unterminated" })
})

test("loadEnvFile: an explicitly empty quoted value stays empty", () => {
    // documented: a key with no value anywhere fails the whole load
    const path = writeEnv(`${A}=""\n`)
    eq(loadEnvFile(path, [A]), { [A]: "" })
})

test("loadEnvFile: whitespace variants and the optional export prefix", () => {
    const path = writeEnv(`  ${A}  =  spaced out  \nexport ${B}=exported\n`)
    eq(loadEnvFile(path, [A, B]), { [A]: "spaced out", [B]: "exported" })
    const tabs = writeEnv(`\t${A}\t=\ttabbed\t\n`)
    eq(loadEnvFile(tabs, [A]), { [A]: "tabbed" })
})

test("loadEnvFile: only requested keys are returned", () => {
    const path = writeEnv(`${A}=alpha\nOTHER_KEY=nope\n${B}=beta\n`)
    eq(loadEnvFile(path, [A]), { [A]: "alpha" })
    // a requested key absent from the file is absent from the record
    eq(loadEnvFile(path, [A, "WAM_TEST_CREDS_MISSING"]), { [A]: "alpha" })
    eq(loadEnvFile(path, ["WAM_TEST_CREDS_MISSING"]), {})
})

test("loadEnvFile: duplicate keys keep the last value", () => {
    const path = writeEnv(`${A}=first\n${A}=second\n`)
    eq(loadEnvFile(path, [A]), { [A]: "second" })
})

test("loadEnvFile: missing file (or a directory) returns null", () => {
    eq(loadEnvFile(`${TMP}/creds-no-such-file`, [A]), null)
    eq(loadEnvFile(TMP, [A]), null)
})

test("loadCredentials: file fills every key when the env is unset", () => {
    withEnv({ [A]: null, [B]: null }, () => {
        const path = writeEnv(`${A}=from-file-a\n${B}=from-file-b\n`)
        eq(loadCredentials("Test", [A, B], path), { [A]: "from-file-a", [B]: "from-file-b" })
    })
})

test("loadCredentials: env vars take precedence over file values, per key", () => {
    withEnv({ [A]: "from-env", [B]: null }, () => {
        const path = writeEnv(`${A}=from-file-a\n${B}=from-file-b\n`)
        eq(loadCredentials("Test", [A, B], path), { [A]: "from-env", [B]: "from-file-b" })
    })
})

test("loadCredentials: an empty env var falls through to the file", () => {
    withEnv({ [A]: "", [B]: null }, () => {
        const path = writeEnv(`${A}=from-file-a\n${B}=from-file-b\n`)
        eq(loadCredentials("Test", [A, B], path), { [A]: "from-file-a", [B]: "from-file-b" })
    })
})

test("loadCredentials: a complete env wins over the file wholesale", () => {
    withEnv({ [A]: "env-a", [B]: "env-b" }, () => {
        // group-readable on purpose: the env-complete path must not
        // even stat the file, so no warning is owed (smoke, see NOTE)
        const path = writeEnv(`${A}=file-a\n${B}=file-b\n`, 0o644)
        eq(loadCredentials("Test", [A, B], path), { [A]: "env-a", [B]: "env-b" })
    })
})

test("loadCredentials: null when any key has no value anywhere", () => {
    withEnv({ [A]: null, [B]: null }, () => {
        const path = writeEnv(`${A}=only-a\n`)
        eq(loadCredentials("Test", [A, B], path), null)
        // an empty value (KEY="") counts as missing
        const empty = writeEnv(`${A}=a\n${B}=""\n`)
        eq(loadCredentials("Test", [A, B], empty), null)
    })
})

test("loadCredentials: null when the file is missing and the env is incomplete", () => {
    withEnv({ [A]: "only-env-a", [B]: null }, () => {
        eq(loadCredentials("Test", [A, B], `${TMP}/creds-no-such-file`), null)
    })
})

test("warnPerms: every branch runs without throwing (smoke, see NOTE)", () => {
    // loose perms: the 0o077 check fires (warning goes to stderr)
    warnPerms("Test", writeEnv(`${A}=x\n`, 0o644))
    // 0600: silent path
    warnPerms("Test", writeEnv(`${A}=x\n`, 0o600))
    // missing file: the stat-failure catch
    warnPerms("Test", `${TMP}/creds-no-such-file`)
})
