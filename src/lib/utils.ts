/**
 * File: utils.ts
 * Description: Mainly for helper functions
 */
import GLib from "gi://GLib?version=2.0";


/**
 * Tests if a path points to a valid path
 * Will return true if the tested file is a symlink to a regular file.
 * @param path Path to a file
 */
export function isFile(path: string): boolean {
    return GLib.file_test(path, GLib.FileTest.EXISTS)
}