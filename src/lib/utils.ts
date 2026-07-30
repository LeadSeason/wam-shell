/**
 * File: utils.ts
 * Description: Mainly for helper functions
 */
import GLib from "gi://GLib?version=2.0"
import Pango from "gi://Pango?version=1.0"

/**
 * Tests if a path points to a valid path
 * Will return true if the tested file is a symlink to a regular file.
 * @param path Path to a file
 */
export function isFile(path: string): boolean {
    // IS_REGULAR, not EXISTS: a directory at the expected path must not
    // pass (a "config.toml" directory, a cache dir named like a cover…)
    return GLib.file_test(path, GLib.FileTest.IS_REGULAR)
}

/**
 * Body text for useMarkup labels. The notification spec allows markup,
 * but plenty of apps send raw text with & or < in it — that fails Pango
 * parsing and renders an empty label. Keep valid markup, escape the
 * rest.
 */
export function safeMarkup(s: string): string {
    try {
        Pango.parse_markup(s, -1, "\x00")
        return s
    } catch {
        return GLib.markup_escape_text(s, -1)
    }
}
