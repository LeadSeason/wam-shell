import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import { test, eq } from "./framework"
import { isFile, safeMarkup } from "../src/lib/utils"

const TMP = GLib.getenv("WAM_TEST_TMP")!

const file = `${TMP}/utils-file`
const dir = `${TMP}/utils-dir`
const link = `${TMP}/utils-link`
GLib.file_set_contents(file, "x")
GLib.mkdir_with_parents(dir, 0o755)
Gio.File.new_for_path(link).make_symbolic_link(file, null)

test("isFile: regular file passes", () => {
    eq(isFile(file), true)
})

test("isFile: directory is not a file", () => {
    eq(isFile(dir), false)
})

test("isFile: missing path fails", () => {
    eq(isFile(`${TMP}/utils-missing`), false)
})

test("isFile: symlink to a regular file passes", () => {
    eq(isFile(link), true)
})

test("safeMarkup: valid markup is kept", () => {
    eq(safeMarkup("<b>hi</b>"), "<b>hi</b>")
})

test("safeMarkup: raw ampersand is escaped", () => {
    eq(safeMarkup("a & b"), "a &amp; b")
})

test("safeMarkup: raw angle brackets are escaped", () => {
    eq(safeMarkup("1 < 2"), "1 &lt; 2")
})

test("safeMarkup: anchor tags are stripped, link text kept", () => {
    // Pango has no <a> support; web notifications wrap links in anchors
    eq(safeMarkup('<a href="https://app.todoist.com/">app.todoist.com</a>'), "app.todoist.com")
    // surrounding text (incl. RTL) and other valid markup survive
    eq(
        safeMarkup('بسم الله <a href="https://x.example/">x.example</a> <b>Today 09:00</b>'),
        "بسم الله x.example <b>Today 09:00</b>",
    )
})
