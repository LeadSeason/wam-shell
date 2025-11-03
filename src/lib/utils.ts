/** 
 * File: utils.ts
 * Description: Mainly for helper functions 
 */
import GLib from "gi://GLib?version=2.0";
import Gtk from "gi://Gtk?version=4.0";


/**
 * Tests if a path points to a valid path
 * Will return true if the tested file is a symlink to a regular file.
 * @param path Path to a file
 */
export function isFile(path: string): boolean {
    return GLib.file_test(path, GLib.FileTest.IS_REGULAR)
}

/**
 * iconLookup tool.
 * @param iconName - Icon to be locked up
 * @returns Returns null if no icon found otherwise gives a valid icon name.
 */
export function iconLookup(iconName: string): string | null {
    const icon = new Gtk.IconTheme().lookup_icon((iconName != null) ? iconName : "", null, 48, 1, null, null).get_icon_name()
    if (icon !== "image-missing") {
        return icon;
    }
    return null;
}