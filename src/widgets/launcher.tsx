import { Astal, Gdk, Gtk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import Pango from "gi://Pango?version=1.0"
import Graphene from "gi://Graphene?version=1.0"
import AstalApps from "gi://AstalApps?version=0.1"
import app from "ags/gtk4/app"
import { createRoot, createState, For } from "gnim"
import CommandRegistry from "../lib/requestHandler"
import { hideOnFocusLoss } from "../lib/popupFocus"
import { registerPopup, closeOtherPopups } from "../lib/exclusivePopups"
import { execAsync, timeoutAdd, sourceRemove } from "../lib/metrics"
import {
    available as clipboardAvailable,
    copy as copyClip,
    history,
    type ClipEntry,
} from "../lib/clipboard"

// The launcher, and the shell's command palette, in one window.
//
// Two things that are normally separate programs, and they are together
// here for a reason that is specific to this shell: `lib/commandRegistry`
// is already a self-describing list of everything the shell can be told
// to do — every entry carries a name, its aliases and a description,
// because `ags request help` prints them. Nothing was reading that list
// from INSIDE the shell. Typing ">" switches the same window from
// searching .desktop files to searching those commands, so
// "sleep-timer 30" or "qsPane wifi" is reachable without remembering
// either the syntax or which keybind you gave it.
//
// Prefixes rather than tabs: a mode you have to click into is a mode
// you forget exists.

const registry = CommandRegistry.get_default()

const MAX_ROWS = 8
const COMMAND_PREFIX = ">"
const CLIPBOARD_PREFIX = ":"

interface Row {
    key: string
    name: string
    description: string
    icon: string
    /** run it. The launcher is already hidden by the time this fires. */
    activate: () => void
}

let apps: AstalApps.Apps | null = null
function appsSource(): AstalApps.Apps {
    // Built on first open, not at import: reading every .desktop file on
    // the system is not something a shell that may never open a launcher
    // should pay for at startup.
    if (!apps) apps = new AstalApps.Apps()
    return apps
}

function appRows(query: string): Row[] {
    const source = appsSource()
    const list =
        query === ""
            ? // nothing typed: the apps you actually launch, most-used
              // first. AstalApps counts launches through its own
              // `launch()`, so this gets better the longer it is used —
              // and alphabetical order, the alternative, is only ever
              // right by coincidence
              [...source.list].sort(
                  (a, b) => b.frequency - a.frequency || a.name.localeCompare(b.name),
              )
            : source.fuzzy_query(query)

    return list.slice(0, MAX_ROWS).map(entry => ({
        key: `app:${entry.entry}`,
        name: entry.name,
        description: entry.description ?? "",
        icon: entry.iconName || "application-x-executable-symbolic",
        // AstalApps.launch() both spawns through the desktop file (so
        // the process is detached from the shell) and bumps the
        // frequency counter the empty-query list above sorts on
        activate: () => {
            if (!entry.launch()) console.warn(`launcher: ${entry.entry} failed to launch`)
        },
    }))
}

function commandRows(rest: string): Row[] {
    // "sleep-timer 30" — the first token picks the command, everything
    // after it is passed through as arguments. So the palette is not
    // just a menu of verbs: it is the request interface with completion.
    const [term = "", ...args] = rest.split(/\s+/).filter(Boolean)
    const trailingSpace = rest.endsWith(" ")
    const matches = registry
        .list()
        .filter(
            cmd =>
                term === "" ||
                cmd.aliases.some(a => a.toLowerCase().includes(term.toLowerCase())) ||
                cmd.description.toLowerCase().includes(term.toLowerCase()),
        )
        // an exact alias match is what the user meant, whatever else
        // happens to contain the same substring
        .sort((a, b) => {
            const exact = (c: typeof a) =>
                c.aliases.some(x => x.toLowerCase() === term.toLowerCase()) ? 0 : 1
            return exact(a) - exact(b) || a.name.localeCompare(b.name)
        })

    return matches.slice(0, MAX_ROWS).map(cmd => ({
        key: `cmd:${cmd.name}`,
        name: args.length > 0 ? `${cmd.name} ${args.join(" ")}` : cmd.name,
        description: cmd.description,
        icon: "system-run-symbolic",
        activate: () => {
            // Only pass the typed arguments to the command the user
            // actually landed on — picking a DIFFERENT row than the one
            // being typed at means the arguments were for the other one.
            const chosen = cmd.aliases.some(a => a.toLowerCase() === term.toLowerCase())
            const argv = chosen || trailingSpace ? [cmd.name, ...args] : [cmd.name]
            // fire and forget: request commands answer with a string
            // meant for a terminal, and the launcher is already closing.
            // It still reaches the log, which is where a command that
            // failed is worth reading.
            registry
                .execute(argv)
                .then(out => console.log(`launcher: ${out}`))
                .catch(e => console.warn("launcher: command failed:", e))
        },
    }))
}

// Nothing matched: offer to run what was typed. The one thing a
// launcher must never do is answer a typed command line with an empty
// list — `htop` is not a .desktop file and never will be.
function runRow(query: string): Row[] {
    // THROWS on an unbalanced quote — GJS surfaces the GError, and this
    // runs from the entry's changed handler, so typing a single `"` blew
    // up inside the keystroke rather than simply matching nothing. A
    // half-typed quoted argument is a normal thing to have on screen.
    let argv: string[] | null = null
    try {
        argv = GLib.shell_parse_argv(query)[1]
    } catch {
        return []
    }
    if (!argv || argv.length === 0) return []
    if (!GLib.find_program_in_path(argv[0]!)) return []
    return [
        {
            key: `run:${query}`,
            name: `Run ${query}`,
            description: "Execute this command",
            icon: "system-run-symbolic",
            activate: () => {
                execAsync(argv).catch(e => console.warn(`launcher: ${query} failed:`, e))
            },
        },
    ]
}

// Clipboard history is a MODE, not a window of its own, and that is the
// whole argument for it: a clipboard history is a list you search and
// pick from, which is a launcher. It gets the entry, the filtering, the
// keyboard handling and the styling for free, and the alternative — a
// fourth near-identical surface — would have to keep all four in step.
//
// The history is fetched when the mode is entered rather than per
// keystroke: `cliphist list` is a process, and filtering a few hundred
// lines in memory is not.
let clips: ClipEntry[] = []
const [clipsLoaded, setClipsLoaded] = createState(false)

function loadClips() {
    if (!clipboardAvailable()) {
        clips = []
        setClipsLoaded(true)
        return
    }
    history()
        .then(list => {
            clips = list
            setClipsLoaded(true)
            // the rows were built from an empty list a moment ago
            if (entry?.text.startsWith(CLIPBOARD_PREFIX)) refresh(entry.text)
        })
        .catch(e => console.warn("launcher: clipboard history failed:", e))
}

function clipboardRows(query: string): Row[] {
    if (!clipboardAvailable()) {
        return [
            {
                key: "clip:missing",
                name: "Clipboard history is not available",
                description: "Install cliphist and wl-clipboard to use this",
                icon: "edit-paste-symbolic",
                activate: () => {},
            },
        ]
    }
    if (clips.length === 0 && clipsLoaded.get()) {
        return [
            {
                key: "clip:empty",
                name: "No clipboard history",
                description: "Is `wl-paste --watch cliphist store` running?",
                icon: "edit-paste-symbolic",
                activate: () => {},
            },
        ]
    }
    const term = query.trim().toLowerCase()
    return clips
        .filter(clip => term === "" || clip.preview.toLowerCase().includes(term))
        .slice(0, MAX_ROWS)
        .map(clip => ({
            key: `clip:${clip.id}`,
            name: clip.preview,
            description: "",
            icon: "edit-paste-symbolic",
            // copy, not paste: pasting means synthesising a key press
            // into whatever happens to be focused, which is both
            // compositor-specific and a good way to type into the wrong
            // window. The next Ctrl+V is the user's to spend.
            activate: () => copyClip(clip.id),
        }))
}

function rowsFor(text: string): Row[] {
    if (text.startsWith(COMMAND_PREFIX)) return commandRows(text.slice(COMMAND_PREFIX.length))
    if (text.startsWith(CLIPBOARD_PREFIX)) return clipboardRows(text.slice(CLIPBOARD_PREFIX.length))
    if (text === "") return appRows("")

    const found = appRows(text)
    const run = runRow(text)
    if (run.length === 0) return found

    // The query IS a program on $PATH, so it is not a guess — and the
    // fuzzy matcher will otherwise bury it. "htop" scored five
    // applications here (a GitHub client, an lstopo frontend, a photo
    // manager…) purely on shared letters, none of them htop, and Enter
    // would have launched the first of them.
    //
    // An application that IS that program still wins: the desktop entry
    // knows its icon, its real name and its startup notification, and
    // bare argv knows none of those. Matched on the Exec field as well
    // as the name, because the two rarely agree — typing "btop" found a
    // desktop entry called "btop++", and offering to run the binary
    // above the entry for the same binary is just noise.
    const wanted = text.trim().toLowerCase()
    const named = appsSource().list.some(entry => {
        if (entry.name.toLowerCase() === wanted) return true
        // Exec carries arguments and field codes ("foo --flag %U")
        const exec = (entry.executable ?? "").split(/\s+/)[0] ?? ""
        return exec !== "" && GLib.path_get_basename(exec).toLowerCase() === wanted
    })
    return named ? found : [...run, ...found].slice(0, MAX_ROWS)
}

const [rows, setRows] = createState<Row[]>([])
const [selected, setSelected] = createState(0)

let win: Astal.Window | null = null
let card: Gtk.Box | null = null
let rev: Gtk.Revealer | null = null
let entry: Gtk.Entry | null = null
let hideSource: number | null = null

registerPopup("launcher", () => {
    if (win?.is_visible()) hide()
})

function refresh(text: string) {
    // entering clipboard mode: fetch once, then filter in memory
    if (text.startsWith(CLIPBOARD_PREFIX) && !clipsLoaded.get()) loadClips()
    const next = rowsFor(text)
    setRows(next)
    // Always back to the top on a new query. Keeping the index would
    // leave the highlight on whatever happens to be in that position
    // now, which is how a launcher opens the wrong thing.
    setSelected(0)
}

function move(delta: number) {
    const count = rows.get().length
    if (count === 0) return
    // wraps: with at most eight rows, running off the end and stopping
    // is more annoying than looping
    setSelected((selected.get() + delta + count) % count)
}

function activateSelected() {
    const row = rows.get()[selected.get()]
    if (!row) return
    // hide FIRST: launching an app hands focus to it, and a launcher
    // still on screen when the window appears is a launcher that
    // flickers over it
    hide()
    row.activate()
}

function show(initial = "") {
    closeOtherPopups("launcher")
    if (hideSource !== null) {
        sourceRemove(hideSource)
        hideSource = null
    }
    // Reloading catches apps installed since the last open. It is a
    // directory scan, and it happens while the window is already coming
    // up rather than before it, so it costs nothing visible.
    appsSource().reload()
    // the clipboard moved on since the last open, by definition
    setClipsLoaded(false)
    entry!.set_text(initial)
    // caret after the prefix, so opening straight into a mode is ready
    // to type into rather than ready to be corrected
    entry!.set_position(-1)
    refresh(initial)
    win!.present()
    rev!.revealChild = true
    entry!.grab_focus()
}

function hide() {
    if (!win) return
    rev!.revealChild = false
    if (hideSource !== null) sourceRemove(hideSource)
    hideSource = timeoutAdd("launcher:hide", GLib.PRIORITY_DEFAULT, 150, () => {
        hideSource = null
        win!.hide()
        return GLib.SOURCE_REMOVE
    })
}

function onKey(_e: Gtk.EventControllerKey, keyValue: number) {
    switch (keyValue) {
        case Gdk.KEY_Escape:
            hide()
            return true
        case Gdk.KEY_Down:
            move(1)
            return true
        case Gdk.KEY_Up:
            move(-1)
            return true
        // Tab cycles like Down. Without this it moves GTK's own focus
        // out of the entry, and the next keystroke goes nowhere.
        case Gdk.KEY_Tab:
            move(1)
            return true
        case Gdk.KEY_ISO_Left_Tab:
            move(-1)
            return true
        default:
            return false
    }
}

function onClick(_e: Gtk.GestureClick, _: number, x: number, y: number) {
    const [, rect] = card!.compute_bounds(win!)
    if (!rect.contains_point(new Graphene.Point({ x, y }))) hide()
}

function ResultRow({ row, index }: { row: Row; index: number }) {
    return (
        <box
            cssClasses={selected.as(s => ["launcherRow", ...(s === index ? ["selected"] : [])])}
            spacing={10}
        >
            <Gtk.GestureClick
                button={1}
                onPressed={() => {
                    setSelected(index)
                    activateSelected()
                }}
            />
            <image iconName={row.icon} pixelSize={24} />
            <box orientation={Gtk.Orientation.VERTICAL} hexpand>
                <label cssClasses={["launcherName"]} label={row.name} xalign={0} />
                {row.description !== "" && (
                    <label
                        cssClasses={["launcherDesc"]}
                        label={row.description}
                        xalign={0}
                        maxWidthChars={60}
                        ellipsize={Pango.EllipsizeMode.END}
                    />
                )}
            </box>
        </box>
    )
}

function ensureWindow() {
    if (win) return
    createRoot(() => {
        app.add_window(
            (
                <window
                    $={self => {
                        win = self
                        hideOnFocusLoss(win, hide)
                    }}
                    name="Launcher"
                    class="Launcher"
                    namespace="launcher"
                    anchor={
                        Astal.WindowAnchor.TOP |
                        Astal.WindowAnchor.BOTTOM |
                        Astal.WindowAnchor.LEFT |
                        Astal.WindowAnchor.RIGHT
                    }
                    // EXCLUSIVE, unlike every other popup in the shell,
                    // and this is the one place it is right: a launcher
                    // that does not have the keyboard the instant it
                    // appears is a launcher that eats the first three
                    // letters of what you typed. It is also the only
                    // surface here whose entire purpose is typing.
                    keymode={Astal.Keymode.EXCLUSIVE}
                    visible={false}
                >
                    <Gtk.EventControllerKey onKeyPressed={onKey} />
                    <Gtk.GestureClick onPressed={onClick} />
                    <revealer
                        $={self => {
                            rev = self
                        }}
                        hexpand
                        vexpand
                        transitionDuration={150}
                        transitionType={Gtk.RevealerTransitionType.CROSSFADE}
                    >
                        {/* expanding child, not a background on the
                        window: see the note in sessionMenu.tsx */}
                        <box hexpand vexpand valign={Gtk.Align.FILL} halign={Gtk.Align.FILL}>
                            <box
                                cssClasses={["launcherCard"]}
                                orientation={Gtk.Orientation.VERTICAL}
                                spacing={8}
                                hexpand
                                // a third of the way down rather than
                                // centred: the list grows downwards, and
                                // a centred card jumps as it does
                                valign={Gtk.Align.START}
                                halign={Gtk.Align.CENTER}
                                marginTop={140}
                                $={self => {
                                    card = self as Gtk.Box
                                }}
                            >
                                <entry
                                    $={self => {
                                        entry = self as Gtk.Entry
                                    }}
                                    cssClasses={["launcherEntry", "textInput"]}
                                    placeholderText={`Search apps · ${COMMAND_PREFIX} commands · ${CLIPBOARD_PREFIX} clipboard`}
                                    hexpand
                                    onChanged={self => refresh(self.text)}
                                    onActivate={activateSelected}
                                />
                                <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                                    <For each={rows} id={row => row.key}>
                                        {(row, index) => (
                                            <ResultRow row={row} index={index.get()} />
                                        )}
                                    </For>
                                </box>
                            </box>
                        </box>
                    </revealer>
                </window>
            ) as Gtk.Window,
        )
    })
}

function toggle(initial = ""): string {
    ensureWindow()
    // Already open in a DIFFERENT mode: switch to the asked-for one
    // rather than closing. Pressing the clipboard keybind while the
    // launcher happens to be up should show the clipboard, not dismiss
    // the window and leave the user pressing it again.
    if (win!.is_visible()) {
        if (initial !== "" && !entry!.text.startsWith(initial)) {
            entry!.set_text(initial)
            entry!.set_position(-1)
            refresh(initial)
            return "switched"
        }
        hide()
        return "hidden"
    }
    show(initial)
    return "shown"
}

registry.register({
    name: ["launcher", "run", "apps"],
    description: "Toggle the app launcher and command palette",
    help: `launcher
  Toggles it. Type to filter applications; "${COMMAND_PREFIX}" switches to
  the shell's own commands, arguments included ("${COMMAND_PREFIX}sleep-timer 30"),
  and "${CLIPBOARD_PREFIX}" to the clipboard history.
  A query that matches no application but IS on $PATH offers to run it.
  Up/Down or Tab moves, Enter runs, Escape closes.`,
    main: () => toggle(),
})

registry.register({
    name: ["clipboard", "clip"],
    description: "Open the clipboard history",
    help: `clipboard
  Opens the launcher in clipboard mode ("${CLIPBOARD_PREFIX}"). Picking an entry
  puts it back on the clipboard; it does not paste it.
  Needs cliphist and wl-clipboard, with "wl-paste --watch cliphist store"
  running from the compositor config.`,
    main: () => toggle(CLIPBOARD_PREFIX),
})
