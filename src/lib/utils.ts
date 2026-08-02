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
 * Base text direction for alignment: true when the first strong
 * directional character is RTL (Hebrew, Arabic, …). Use to flip xalign.
 * NB: Pango.Direction has no STRONG_* members (that's fribidi);
 * find_base_dir returns LTR / RTL / NEUTRAL.
 */
export function isRtl(s: string): boolean {
    return Pango.find_base_dir(s, -1) === Pango.Direction.RTL
}

/**
 * Prepend an invisible right-to-left mark (U+200F) to every paragraph.
 * Gtk labels enable Pango auto-dir, which aligns each line by its OWN
 * paragraph direction — so a small LTR line ("Today 13:00") would hug
 * the left of an RTL card. The mark forces RTL base direction instead.
 */
export function rtlAlign(s: string): string {
    return "\u200F" + s.replaceAll("\n", "\n\u200F")
}

/**
 * Body text for useMarkup labels. The notification spec allows markup,
 * but plenty of apps send raw text with & or < in it — that fails Pango
 * parsing and renders an empty label. Keep valid markup, escape the
 * rest. One mending step first: Pango has no <a> support ("Unknown
 * tag 'a'"), and web notifications wrap links in anchors — strip the
 * tags, keep the link text, and retry.
 */
export function safeMarkup(s: string): string {
    try {
        Pango.parse_markup(s, -1, "\x00")
        return s
    } catch {
        try {
            const noAnchors = s.replace(/<a\s[^>]*>/g, "").replaceAll("</a>", "")
            Pango.parse_markup(noAnchors, -1, "\x00")
            return noAnchors
        } catch {
            return GLib.markup_escape_text(s, -1)
        }
    }
}
