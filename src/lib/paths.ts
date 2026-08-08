import GLib from "gi://GLib?version=2.0"

// Where the shell keeps user-owned files. One definition, because six
// modules had their own copy of the same expression and two independent
// definitions of a path drift — the one that drifts reads credentials
// from somewhere nobody writes them, with no error anywhere to say so
// (the same reasoning as config.ts's pendingUpdatesPath).

/**
 * `~/.config/wam-shell` — where per-service credential files
 * (`github.env`, `google.env`, …) and OAuth token stores live.
 *
 * XDG_CONFIG_HOME wins when set, exactly as `Config`'s own config-file
 * search does.
 */
export const configHome = `${GLib.getenv("XDG_CONFIG_HOME") || `${GLib.getenv("HOME")}/.config`}/wam-shell`
