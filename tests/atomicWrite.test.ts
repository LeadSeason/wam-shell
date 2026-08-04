import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { readFile } from "ags/file"
import { test, eq } from "./framework"
import { writeFileAtomic } from "../src/lib/atomicWrite"

const TMP = GLib.getenv("WAM_TEST_TMP")!

// writeFileAtomic is async while the framework's test() is sync: each
// case drives its promises on a nested main loop (metrics-probe.ts
// pattern) and rethrows the first rejection
function run(...promises: Promise<unknown>[]) {
    const loop = new GLib.MainLoop(null, false)
    let failure: unknown = null
    Promise.all(promises).then(
        () => loop.quit(),
        e => {
            failure = e
            loop.quit()
        },
    )
    loop.run()
    if (failure) throw failure
}

const namesInTmp = (prefix: string) => {
    const out: string[] = []
    const enumerator = Gio.File.new_for_path(TMP).enumerate_children(
        "standard::name",
        Gio.FileQueryInfoFlags.NONE,
        null,
    )
    let info: Gio.FileInfo | null
    while ((info = enumerator.next_file(null)) !== null) {
        const name = info.get_name()
        if (name.startsWith(prefix)) out.push(name)
    }
    return out
}

const modeOf = (path: string) =>
    Gio.File.new_for_path(path)
        .query_info("unix::mode", Gio.FileQueryInfoFlags.NONE, null)
        .get_attribute_uint32("unix::mode") & 0o777

test("atomicWrite: writes content and reads it back", () => {
    const path = `${TMP}/atomic-basic`
    run(writeFileAtomic(path, "hello atomic"))
    eq(readFile(path), "hello atomic")
})

test("atomicWrite: writes Uint8Array payloads", () => {
    const path = `${TMP}/atomic-bytes`
    run(writeFileAtomic(path, new TextEncoder().encode("raw bytes ✓")))
    eq(readFile(path), "raw bytes ✓")
})

test("atomicWrite: creates missing parent dirs", () => {
    const path = `${TMP}/atomic-nested/deeper/file`
    run(writeFileAtomic(path, "nested"))
    eq(readFile(path), "nested")
})

test("atomicWrite: no leftover tmp files after resolution", () => {
    const path = `${TMP}/atomic-clean`
    run(writeFileAtomic(path, "x"), writeFileAtomic(path, "y"))
    eq(namesInTmp("atomic-clean.tmp-"), [])
})

test("atomicWrite: concurrent writes resolve in order, last payload wins", () => {
    const path = `${TMP}/atomic-concurrent`
    const order: string[] = []
    const w1 = writeFileAtomic(path, "first").then(() => void order.push("first"))
    const w2 = writeFileAtomic(path, "second").then(() => void order.push("second"))
    run(w1, w2)
    eq(order, ["first", "second"])
    eq(readFile(path), "second")
})

test("atomicWrite: private write lands 0600, even over a wider-moded file", () => {
    const fresh = `${TMP}/atomic-private`
    run(writeFileAtomic(fresh, "secret", { private: true }))
    eq(modeOf(fresh), 0o600)
    eq(readFile(fresh), "secret")

    // overwriting an existing 0644 file must still end at 0600
    const over = `${TMP}/atomic-private-overwrite`
    run(writeFileAtomic(over, "old"))
    Gio.File.new_for_path(over).set_attribute_uint32(
        "unix::mode",
        0o644,
        Gio.FileQueryInfoFlags.NONE,
        null,
    )
    eq(modeOf(over), 0o644)
    run(writeFileAtomic(over, "new", { private: true }))
    eq(modeOf(over), 0o600)
    eq(readFile(over), "new")
})

test("atomicWrite: a rejected write doesn't break the chain", () => {
    const path = `${TMP}/atomic-chain`
    // a directory at the target path makes the rename fail
    Gio.File.new_for_path(path).make_directory(null)
    const order: string[] = []
    const bad = writeFileAtomic(path, "boom").then(
        () => order.push("bad-ok"),
        () => {
            order.push("bad-failed")
            // clear the way for the queued write
            Gio.File.new_for_path(path).delete(null)
        },
    )
    const good = writeFileAtomic(path, "recovered").then(
        () => order.push("good-ok"),
        () => order.push("good-failed"),
    )
    run(bad, good)
    eq(order, ["bad-failed", "good-ok"])
    eq(readFile(path), "recovered")
})
