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
    return GLib.file_test(path, GLib.FileTest.EXISTS)
}

/**
 * iconLookup tool. ! This Function is slow !
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

/**
 * converting unix epoch to time. Ignores date.
 * @param timeInSeconds 
 * @returns returns time in "16:50:39" format
 */
export function secondsToTime(timeInSeconds: number): string {
    /* @ts-expect-error */
    const date = new Date(null);
    date.setSeconds(timeInSeconds); // specify value for SECONDS here
    return date.toISOString().slice(11, 19);
}

/**
 * Uppercases the first character of a string, leaving the rest untouched.
 * @param text
 */
export function capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1)
}
