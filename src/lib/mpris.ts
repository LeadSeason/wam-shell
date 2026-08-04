import AstalMpris from "gi://AstalMpris?version=0.1"
import AstalApps from "gi://AstalApps"
import GioUnix from "gi://GioUnix?version=2.0"
import GLib from "gi://GLib?version=2.0"
import { Gtk } from "ags/gtk4"
import { Accessor, createBinding, createComputed, createState, onCleanup } from "gnim"
import { connect, disconnect, execAsync, timeoutAdd, sourceRemove } from "./metrics"
import Config from "../config"
import { downloadCover } from "./coverArt"

// Shared MPRIS state + helpers, used by the QS media section and the
// panel media widget/popup.

const mpris = AstalMpris.get_default()

// perf harness (tests/perf/run.sh sets WAM_SHELL_NO_MPRIS=1): hide the
// live session's players so media counters (seek-scale connections,
// position timers) measure the code, not whatever happens to be
// playing on the developer's session (#58)
const hidePlayers = GLib.getenv("WAM_SHELL_NO_MPRIS") === "1"

const rawPlayers = createBinding(mpris, "players")

// one process can own several MPRIS names when multiple bridges are
// installed (mpv-mpris uses mpv.instance<PID>, others mpv.instance-<id>
// and bare "mpv"): each name shows up as its own player. collapse
// duplicates reporting the same identity and track
export const players = rawPlayers.as(list => {
    if (hidePlayers) return []
    const seen = new Set<string>()
    return list.filter(p => {
        const key = `${p.identity}\n${p.title}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
})

/** browsers scrub private-session metadata instead of hiding it: the
 *  track title arrives as an anonymized "<X> is playing media"
 *  placeholder — chromium sends "A site is playing media", firefox
 *  "Firefox is playing media" (english locale strings). treat it as
 *  no track at all — private windows must not surface in the UI */
const isEligible = (p: AstalMpris.Player) =>
    (p.title !== "" || p.playbackStatus !== AstalMpris.PlaybackStatus.STOPPED) &&
    !(Config.media.hidePrivateSessions && p.title.endsWith(" is playing media"))

/** eligible players for display (segment strip, switcher, tooltips).
 *  eligibility also changes with per-player title/status, which the
 *  manager's players list does not notify — the hooks below bump this
 *  version so dependents refresh.
 *  NOTE: imperative readers (pick, cycle) must NOT use this accessor:
 *  createComputed caches dep values with a falsy check, and an empty
 *  [] cached at startup (players load async) is truthy and never
 *  refreshes without a subscriber. use players.get().filter(isEligible) */
const [eligVersion, bumpElig] = createState(0)
export const eligiblePlayers = createComputed([players, eligVersion], list =>
    list.filter(isEligible),
)

// the player shown everywhere: sticky — stays on the current player
// until it goes away or another player starts playing (the most recent
// one wins). A manual pick via the popup switcher or scroll cycling
// overrides until that player goes
const [activePlayer, setActivePlayer] = createState<AstalMpris.Player | null>(null)
const [overridePlayer, setOverride] = createState<AstalMpris.Player | null>(null)

export { activePlayer }

/** pin a specific player (popup switcher); null returns to auto-pick */
export function overrideActivePlayer(player: AstalMpris.Player | null) {
    setOverride(player)
    pick()
}

/** cycle the active player through the eligible ones (scroll on the
 *  panel pill); a no-op with fewer than two */
export function cycleActivePlayer(direction: 1 | -1) {
    const eligible = players.get().filter(isEligible)
    if (eligible.length < 2) return
    const current = activePlayer.get()
    const i = current ? eligible.indexOf(current) : -1
    const next = eligible[(i + direction + eligible.length) % eligible.length]
    overrideActivePlayer(next)
}

// smooth-scroll devices emit a stream of small deltas per gesture:
// accumulate them so one gesture switches one player, not a frenzy
let scrollAcc = 0
let scrollAt = 0
let lastSwitch = 0

/** cycle on scroll: switches once per accumulated wheel notch, and at
 *  most once per 300ms so a touchpad flick cannot chain-switch */
export function scrollActivePlayer(dy: number) {
    if (dy === 0) return
    const now = GLib.get_monotonic_time() / 1e6
    // drop the momentum tail right after a switch
    if (now - lastSwitch < 0.3) {
        scrollAcc = 0
        scrollAt = now
        return
    }
    if (now - scrollAt > 0.5) scrollAcc = 0
    scrollAt = now
    scrollAcc += dy
    if (Math.abs(scrollAcc) >= 1) {
        const direction = scrollAcc > 0 ? 1 : -1
        lastSwitch = now
        scrollAcc = 0
        cycleActivePlayer(direction)
    }
}

/** play/pause from shell buttons: pauses all other players
 *  synchronously first — the playback-status hook does the same
 *  reactively, but only after a bus round-trip, so a beat of double
 *  output would slip through */
export function playPauseExclusive(player: AstalMpris.Player) {
    if (player.playbackStatus !== AstalMpris.PlaybackStatus.PLAYING) {
        for (const p of players.get()) {
            if (p !== player && p.playbackStatus === AstalMpris.PlaybackStatus.PLAYING) {
                p.pause()
            }
        }
    }
    player.play_pause()
}

// app database for the fuzzy name match, built on first use
let appDb: AstalApps.Apps | null = null

/** resolve a player to its window's wm class via the desktop entry
 *  database ("Brave" -> "brave-browser", "VLC media player" -> "vlc") */
function resolveWmClass(player: AstalMpris.Player): string | null {
    const names = [player.entry, player.identity]
        .filter((n): n is string => !!n)
        .map(n => n.replace(/\.desktop$/, "").toLowerCase())

    // desktop entry by id, like the icon resolver does; the -browser
    // suffix catches identities like "Brave". a shadowing user entry
    // (~/.local/share/applications/mpv.desktop) may lack
    // StartupWMClass — then the entry id itself is the best class guess
    for (const n of names) {
        const app =
            GioUnix.DesktopAppInfo.new(`${n}.desktop`) ??
            GioUnix.DesktopAppInfo.new(`${n}-browser.desktop`)
        if (app) return app.get_startup_wm_class() ?? n
    }

    // fuzzy fallback: app name match in the app database
    if (!appDb) appDb = new AstalApps.Apps()
    for (const app of appDb.get_list()) {
        const wm = app.get_wm_class()
        if (!wm) continue
        const appName = app.get_name()?.toLowerCase()
        for (const n of names) {
            if (appName === n) return wm
        }
    }
    return null
}

/** raise/focus the player's window. MPRIS Raise only works when the
 *  player reports CanRaise (firefox) — brave and mpv report false and
 *  no-op (vlc lies yet complies). when CanRaise is false, focus the
 *  window through the compositor instead */
export function raisePlayer(player: AstalMpris.Player) {
    if (player.canRaise) return player.raise()
    // no shell anywhere below (argv exec), but the class is still
    // interpolated into hyprctl lua / swaymsg criteria syntax — the
    // sanitize guards THOSE parsers (quotes, ';', brackets would
    // otherwise break out of the match string into new commands)
    const wmClass = resolveWmClass(player)?.replace(/[^a-zA-Z0-9._-]/g, "")
    if (!wmClass) {
        console.warn(`raisePlayer: no wm class resolved for "${player.identity}"`)
        return player.raise() // a no-op for these, but costs nothing
    }
    if (Config.desktopSession === "hyprland") {
        // lua dispatcher syntax (hyprland >= 0.55): the old
        // "focuswindow class:..." form is rejected by the new parser
        execAsync([
            "hyprctl",
            "dispatch",
            `hl.dsp.focus({ window = "class:^(?i)${wmClass}$" })`,
        ]).catch(e => console.warn("raisePlayer:", e))
    } else if (Config.desktopSession === "sway" || Config.desktopSession === "i3") {
        const msg = Config.desktopSession === "sway" ? "swaymsg" : "i3-msg"
        // app_id covers wayland-native, class covers X11/XWayland
        execAsync([msg, `[app_id="${wmClass}"] focus; [class="${wmClass}"] focus`]).catch(e =>
            console.warn("raisePlayer:", e),
        )
    } else {
        player.raise()
    }
}

// Shared player-hook registry: every consumer registers one hook
// instead of running its own add/release loop over the player list
// (active-player tracking below and the osd media trigger both need
// it). The release fn a hook returns runs when the player quits —
// subscriptions keep dead players alive (browsers spawn one per tab).
type PlayerHook = (p: AstalMpris.Player) => (() => void) | void
const playerHooks = new Set<PlayerHook>()
// releases are tagged with their hook so a single hook can unregister
// (and dispose can run all of them)
const hookedPlayers = new Map<AstalMpris.Player, { hook: PlayerHook; release: () => void }[]>()

function syncPlayers() {
    const list = players.get()
    for (const [p, entries] of hookedPlayers) {
        if (!list.includes(p)) {
            for (const e of entries) e.release()
            hookedPlayers.delete(p)
        }
    }
    for (const p of list) {
        if (hookedPlayers.has(p)) continue
        const entries: { hook: PlayerHook; release: () => void }[] = []
        for (const hook of playerHooks) {
            const release = hook(p)
            if (release) entries.push({ hook, release })
        }
        hookedPlayers.set(p, entries)
    }
    bumpElig()
}
const unsubSyncPlayers = players.subscribe(syncPlayers)
// gnim subscribe does not fire on subscription: hook the players that
// already exist at shell start, or their status/title changes never
// reach pick() and the exclusive-playback hook
syncPlayers()

/** run `hook` for every current and future player; the fn it returns
 *  runs when that player quits. returns an unregister fn: drops the
 *  hook and releases it from every currently hooked player */
export function hookPlayers(hook: PlayerHook): () => void {
    playerHooks.add(hook)
    // backfill players already hooked by earlier registrations
    for (const [p, entries] of hookedPlayers) {
        const release = hook(p)
        if (release) entries.push({ hook, release })
    }
    return () => {
        playerHooks.delete(hook)
        for (const entries of hookedPlayers.values()) {
            for (let i = entries.length - 1; i >= 0; i--) {
                if (entries[i].hook !== hook) continue
                entries[i].release()
                entries.splice(i, 1)
            }
        }
    }
}

function pick() {
    const override = overridePlayer.get()
    const eligible = players.get().filter(isEligible)
    // release pins on players that went away instead of retaining them
    if (override && !eligible.includes(override)) setOverride(null)
    if (lastPlaying && !eligible.includes(lastPlaying)) lastPlaying = null
    // the most recently started player wins over one that has been
    // playing all along ("a video was playing in firefox, then one was
    // started in brave" -> brave takes over)
    const playing =
        lastPlaying &&
        eligible.includes(lastPlaying) &&
        lastPlaying.playbackStatus === AstalMpris.PlaybackStatus.PLAYING
            ? lastPlaying
            : eligible.find(p => p.playbackStatus === AstalMpris.PlaybackStatus.PLAYING)
    const current = activePlayer.get()
    setActivePlayer(
        override && eligible.includes(override)
            ? override
            : // stick with the current player: only switch away when it
              // went away or ANOTHER player started playing (pausing
              // must not flip to the next eligible player)
              current && eligible.includes(current) && (!playing || playing === current)
              ? current
              : (playing ?? eligible[0] ?? null),
    )
}

// the player that most recently entered PLAYING state
let lastPlaying: AstalMpris.Player | null = null

const unsubPick = players.subscribe(pick)
hookPlayers(p => {
    const status = createBinding(p, "playbackStatus").subscribe(() => {
        bumpElig()
        if (p.playbackStatus === AstalMpris.PlaybackStatus.PLAYING) {
            lastPlaying = p
            // a newly playing player always takes over, even from a
            // scroll-pinned one
            if (overridePlayer.get() !== p) setOverride(null)
            // exclusive playback wherever playback starts from — shell
            // buttons, the player's own UI or playerctl: pause the rest
            for (const other of players.get()) {
                if (other !== p && other.playbackStatus === AstalMpris.PlaybackStatus.PLAYING) {
                    other.pause()
                }
            }
        }
        pick()
    })
    const title = createBinding(p, "title").subscribe(() => {
        bumpElig()
        pick()
    })
    return () => {
        status()
        title()
    }
})
pick()

// convention for lib modules with long-lived sources, even though the
// shell never calls it today: one place that tears everything down
export function dispose() {
    unsubSyncPlayers()
    unsubPick()
    for (const [p, entries] of hookedPlayers) {
        for (const e of entries) e.release()
        hookedPlayers.delete(p)
    }
    playerHooks.clear()
}

// GTK css can only load local files; remote (http) cover art is
// downloaded once into the cache dir and the local copy is used
// (downloadCover handles dedup, timeouts and partial files)

/** cover art url as a state, re-resolving when the track changes.
 *  The binding subscription is tied to the calling component's scope. */
export function coverState(player: AstalMpris.Player): Accessor<string> {
    const cover = createBinding(player, "coverArt")
    const [local, setLocal] = createState("")

    const update = () => {
        const url = cover.get()
        if (!url) return setLocal("")
        // astal gives bare paths (no file:// scheme) for local art
        if (url.startsWith("/")) return setLocal(`file://${url}`)
        if (!url.startsWith("http")) return setLocal(url)
        setLocal("")
        downloadCover(url)
            .then(path => {
                // a track change during the download must not let the
                // older cover overwrite the newer one
                if (cover.get() === url) setLocal(`file://${path}`)
            })
            .catch(e => console.warn("cover download failed:", e))
    }
    const unsub = cover.subscribe(update)
    onCleanup(unsub)
    update()
    return local
}

export function formatTime(seconds: number): string {
    if (seconds < 0) seconds = 0
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = Math.floor(seconds % 60)
    return h > 0
        ? `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
        : `${m}:${s.toString().padStart(2, "0")}`
}

export interface SmoothedPosition {
    accessor: Accessor<number>
    /** false while the true position is unknowable: firefox sometimes
     *  never reports Position, and for media that was already playing
     *  when the shell started there is no data source at all. becomes
     *  true on the first real position change, track change or user
     *  seek — the UI shows --:-- until then */
    known: Accessor<boolean>
    /** re-anchor the clock at a user-requested seek target */
    seekTo(value: number): void
}

/** playback position with a client-side clock. some players do not
 *  track Position at all (firefox reports it as 0 while playing), and
 *  online players apply SetPosition asynchronously, so the raw property
 *  is only trusted when it CHANGES: between changes the clock
 *  extrapolates from the last anchor at playback rate. the clock only
 *  runs while playing AND `active` (when given) holds — a hidden
 *  consumer must not wake the shell every second */
export function positionState(
    player: AstalMpris.Player,
    active?: Accessor<boolean>,
): SmoothedPosition {
    const raw = createBinding(player, "position")
    const [smooth, setSmooth] = createState(raw.get())
    // a positive position at creation must have come from the player;
    // 0 tells nothing (true track start or a silent player)
    const [known, setKnown] = createState(raw.get() > 0)

    let anchor = raw.get()
    let anchorAt = GLib.get_monotonic_time() / 1e6
    const reanchor = (value: number) => {
        anchor = value
        anchorAt = GLib.get_monotonic_time() / 1e6
        setSmooth(value)
    }

    // 1s clock, only while playing and active: idle costs nothing
    let timer: number | null = null
    const startClock = () => {
        if (timer !== null) return
        timer = timeoutAdd("mpris:position", GLib.PRIORITY_DEFAULT, 1000, () => {
            setSmooth(anchor + (GLib.get_monotonic_time() / 1e6 - anchorAt))
            return GLib.SOURCE_CONTINUE
        })
    }
    const stopClock = () => {
        if (timer === null) return
        sourceRemove(timer)
        timer = null
    }

    const isOn = () =>
        player.playbackStatus === AstalMpris.PlaybackStatus.PLAYING &&
        (active ? active.get() : true)
    const syncClock = () => {
        if (isOn()) {
            // resume from the frozen position, not from when the clock
            // last ticked — that would count the paused/hidden time
            anchor = smooth.get()
            anchorAt = GLib.get_monotonic_time() / 1e6
            startClock()
        } else {
            stopClock()
        }
    }

    const unsubs = [
        // the raw property is only believed when it changes: a real
        // seek or a track transition (notify does not fire for an
        // unchanged value, and firefox keeps it at 0 forever)
        raw.subscribe(() => {
            setKnown(true)
            reanchor(raw.get())
        }),
        // firefox never moves Position even across tracks; a new title
        // is the only track-change signal it gives. a fresh track
        // genuinely starts at the raw position (usually 0)
        createBinding(player, "title").subscribe(() => {
            setKnown(true)
            reanchor(raw.get())
        }),
        createBinding(player, "playbackStatus").subscribe(syncClock),
    ]
    if (active) unsubs.push(active.subscribe(syncClock))
    syncClock()

    onCleanup(() => {
        unsubs.forEach(u => u())
        stopClock()
    })

    return {
        accessor: smooth,
        known,
        seekTo(value: number) {
            setKnown(true)
            reanchor(value)
        },
    }
}

/** last known positive track length. browser players can drop
 *  mpris:length from a mid-track metadata update (e.g. right after a
 *  seek) — or never send it at all (firefox) — which would flash the
 *  end time to 0:00 and collapse the seek range. resets on track
 *  change so a stale length never leaks into the next track */
export function lengthState(player: AstalMpris.Player): Accessor<number> {
    const length = createBinding(player, "length")
    const title = createBinding(player, "title")
    const [effective, setEffective] = createState(length.get())
    let lastTitle = title.get()
    const unsubs = [
        title.subscribe(() => {
            if (title.get() !== lastTitle) {
                lastTitle = title.get()
                setEffective(length.get())
            }
        }),
        length.subscribe(() => {
            const l = length.get()
            if (l > 0) setEffective(l)
        }),
    ]
    onCleanup(() => unsubs.forEach(u => u()))
    return effective
}

/** wire a Gtk.Scale as a seek bar for `player`: range follows the track
 *  length, the fill follows the position, drags seek. `onSeek` runs on
 *  every user-initiated change, before the position is set. */
export function bindSeekScale(
    self: Gtk.Scale,
    player: AstalMpris.Player,
    position: SmoothedPosition,
    onSeek?: (value: number) => void,
) {
    const length = lengthState(player)

    // when the player never reports a duration but can seek, use a
    // sliding window 2 min past the position: the proportion is a lie,
    // but the bar stays usable (backward seeks are exact)
    const end = () => {
        const l = length.get()
        return l > 0 ? l : Math.max(60, position.accessor.get() + 120)
    }

    // change-value fires only on user input (drag, keys, scroll), never
    // on set_value — so position ticks must yield for a while after the
    // last input instead of testing has_focus (keyboard focus, which
    // dragging does not imply: the tick would fight the drag mid-seek)
    let lastInputAt = 0
    const interacting = () => GLib.get_monotonic_time() / 1e6 - lastInputAt < 1.5

    const syncRange = () => self.set_range(0, end())
    syncRange()
    self.set_value(position.known.get() ? Math.min(position.accessor.get(), end()) : 0)

    const unsubs = [
        length.subscribe(syncRange),
        // an unknowable position shows an empty bar, not a wrong one
        position.known.subscribe(() => {
            self.set_value(position.known.get() ? Math.min(position.accessor.get(), end()) : 0)
        }),
        position.accessor.subscribe(() => {
            if (interacting() || !position.known.get()) return
            syncRange() // keep the fallback window sliding
            self.set_value(Math.min(position.accessor.get(), end()))
        }),
    ]
    const handler = connect(
        self,
        "change-value",
        (_s: Gtk.Scale, _scroll: unknown, value: number) => {
            if (!player.canSeek) return
            lastInputAt = GLib.get_monotonic_time() / 1e6
            onSeek?.(value)
            position.seekTo(value)
            player.position = value
        },
    )
    // the position unsubscribe also keeps the binding from notifying a
    // dead scale after unmount (#16)
    onCleanup(() => {
        unsubs.forEach(u => u())
        disconnect(self, handler)
    })
}

export default mpris
