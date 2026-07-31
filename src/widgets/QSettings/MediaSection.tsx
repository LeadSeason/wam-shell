import AstalMpris from "gi://AstalMpris?version=0.1"
import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib?version=2.0"
import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango?version=1.0"
import { createBinding, createComputed, createState, For, With } from "gnim"
import {
    activePlayer,
    bindSeekScale,
    coverState,
    cycleActivePlayer,
    eligiblePlayers,
    formatTime,
    lengthState,
    overrideActivePlayer,
    playPauseExclusive,
    positionState,
    raisePlayer,
    scrollActivePlayer,
} from "../../lib/mpris"

function MediaButton({
    iconName,
    onPressed,
    sensitive,
}: {
    iconName: string
    onPressed: () => void
    sensitive?: any
}) {
    return (
        <button cssClasses={["mediaButton"]} onClicked={onPressed} sensitive={sensitive}>
            <image iconName={iconName} />
        </button>
    )
}

// quick settings visibility, driven by the window in index.tsx: the
// seeker's position clock only ticks while the popup is open — the
// card stays mounted while a player exists and must not wake the
// shell every second when nobody can see it
export const [qsVisible, setQsVisible] = createState(false)

function Player({ player }: { player: AstalMpris.Player }) {
    const title = createBinding(player, "title")
    const artist = createBinding(player, "artist")
    const status = createBinding(player, "playbackStatus")
    const localCover = coverState(player)

    // seeker: client-side clock — players that do not track Position
    // (firefox reports 0) still get a moving bar, and a user seek is
    // not undone by the player applying it asynchronously. gated on
    // quick settings visibility: no ticking while the popup is closed
    const position = positionState(player, qsVisible)
    // last known positive length: survives players dropping mpris:length
    // mid-track; 0 = the player never reported a duration (firefox)
    const trackLength = lengthState(player)
    const canSeek = createBinding(player, "canSeek")

    // seek revert: position before the current drag began (-1 = nothing
    // to restore). A drag fires change-value per step, so only the first
    // fire of a gesture (gap > 1.5s) records the pre-seek position
    const [revertTo, setRevertTo] = createState(-1)
    let lastSeekAt = 0

    let card: Gtk.Box

    return (
        <box
            cssClasses={["mediaPlayer"]}
            spacing={4}
            // keyboard up/down pages through players while hovering:
            // the card takes focus on pointer enter (never from a text
            // entry — the volume sliders get it back on their own
            // hover)
            focusable
            $={self => {
                card = self
            }}
        >
            <Gtk.EventControllerMotion
                onEnter={() => {
                    const root = card.get_root() as Gtk.Window | null
                    // steal focus from sliders and buttons so arrow keys
                    // page players — but never from a text entry
                    const focus = root?.get_focus()
                    if (focus instanceof Gtk.Entry || focus instanceof Gtk.Text) return
                    card.grab_focus()
                }}
                onLeave={() => {
                    const root = card.get_root() as Gtk.Window | null
                    if (root?.get_focus() === card) root.set_focus(null)
                }}
            />
            <Gtk.EventControllerKey
                onKeyPressed={(_e, keyval) => {
                    if (keyval === Gdk.KEY_Up) {
                        cycleActivePlayer(-1)
                        return true
                    }
                    if (keyval === Gdk.KEY_Down) {
                        cycleActivePlayer(1)
                        return true
                    }
                    return false
                }}
            />
            {/* scroll-position strip on the left edge: one segment per
            player with the shown one lit; click a segment to jump to
            that player. on the side so it does not read as a second
            seeker */}
            <box
                cssClasses={["mediaSegments"]}
                orientation={Gtk.Orientation.VERTICAL}
                spacing={2}
                visible={eligiblePlayers.as(l => l.length > 1)}
            >
                <For each={eligiblePlayers}>
                    {p => (
                        <box
                            vexpand
                            cssClasses={["mediaSegment", ...(p === player ? ["active"] : [])]}
                            tooltipText={p.identity}
                        >
                            <Gtk.GestureClick
                                button={1}
                                onPressed={() => overrideActivePlayer(p)}
                            />
                        </box>
                    )}
                </For>
            </box>
            <box orientation={Gtk.Orientation.VERTICAL} spacing={4} hexpand>
                {/* scroll switches between players when more than one has a
                track loaded (e.g. Firefox and Brave). scoped to this row:
                on the seeker row below scroll must seek, not switch */}
                <box
                    spacing={8}
                    tooltipText={eligiblePlayers.as(l =>
                        l.length > 1 ? "Scroll to switch player" : "",
                    )}
                >
                    <Gtk.EventControllerScroll
                        flags={Gtk.EventControllerScrollFlags.VERTICAL}
                        onScroll={(_e, _dx, dy) => {
                            scrollActivePlayer(dy)
                            return true
                        }}
                    />
                    <box cssName="button" tooltipText="Focus player window">
                        <Gtk.GestureClick button={1} onPressed={() => raisePlayer(player)} />
                        <With value={localCover}>
                            {c =>
                                c ? (
                                    <box
                                        cssClasses={["mediaCover"]}
                                        // the path comes from player metadata — escape
                                        // quotes/backslashes before CSS interpolation
                                        css={`
                                            background-image: url("${c.replace(/['\\]/g, "\\$&")}");
                                        `}
                                    />
                                ) : (
                                    <box cssClasses={["mediaCover", "mediaCoverFallback"]}>
                                        <image iconName="audio-x-generic-symbolic" />
                                    </box>
                                )
                            }
                        </With>
                    </box>
                    {/* click focuses the player's window, same as the cover */}
                    <box
                        orientation={Gtk.Orientation.VERTICAL}
                        hexpand
                        valign={Gtk.Align.CENTER}
                        tooltipText="Focus player window"
                    >
                        <Gtk.GestureClick button={1} onPressed={() => raisePlayer(player)} />
                        {/* widthChars + maxWidthChars together pin the
                        size request: natural = max(width, min(text,
                        max)) = constant, so the popup never resizes
                        per track. ellipsize clips the overflow */}
                        <label
                            cssClasses={["mediaTitle"]}
                            xalign={0}
                            widthChars={24}
                            maxWidthChars={24}
                            ellipsize={Pango.EllipsizeMode.END}
                            label={title.as(t => t || "Unknown title")}
                        />
                        <label
                            cssClasses={["mediaArtist"]}
                            xalign={0}
                            maxWidthChars={24}
                            ellipsize={Pango.EllipsizeMode.END}
                            label={artist.as(a => a || player.identity || "")}
                        />
                    </box>
                    <MediaButton
                        iconName="media-skip-backward-symbolic"
                        onPressed={() => player.previous()}
                        sensitive={createBinding(player, "canGoPrevious")}
                    />
                    <MediaButton
                        iconName={status.as(s =>
                            s === AstalMpris.PlaybackStatus.PLAYING
                                ? "media-playback-pause-symbolic"
                                : "media-playback-start-symbolic",
                        )}
                        onPressed={() => playPauseExclusive(player)}
                        sensitive={createBinding(player, "canPlay")}
                    />
                    <MediaButton
                        iconName="media-skip-forward-symbolic"
                        onPressed={() => player.next()}
                        sensitive={createBinding(player, "canGoNext")}
                    />
                </box>
                {/* seeker (the wiring is shared with the popup:
            bindSeekScale in lib/mpris) */}
                <box cssClasses={["mediaSeek"]} spacing={6}>
                    {/* undo the last drag, mirroring the brightness restore
                button; toggles between the two positions. dimmed until a
                drag has been recorded */}
                    <box
                        cssName="button"
                        cssClasses={createComputed([canSeek, revertTo], (c, r) => [
                            "mediaSeekRevert",
                            ...(c && r >= 0 ? [] : ["disabled"]),
                        ])}
                        tooltipText="Restore pre-seek position"
                    >
                        <Gtk.GestureClick
                            button={1}
                            onPressed={() => {
                                const r = revertTo.get()
                                if (!player.canSeek || r < 0) return
                                // toggle: a second click seeks forward again
                                setRevertTo(position.accessor.get())
                                position.seekTo(r)
                                player.position = r
                            }}
                        />
                        <image iconName="edit-undo-symbolic" />
                    </box>
                    <label
                        cssClasses={["mediaTime"]}
                        // pinned request: "--:--" vs "20:17" vs
                        // "101:47" must not resize the popup
                        widthChars={6}
                        maxWidthChars={6}
                        label={createComputed([position.accessor, position.known], (p, k) =>
                            k ? formatTime(p) : "--:--",
                        )}
                    />
                    <Gtk.Scale
                        $={self =>
                            bindSeekScale(self, player, position, () => {
                                // first fire of a drag: record the pre-seek
                                // position for the revert button
                                const now = GLib.get_monotonic_time() / 1e6
                                if (now - lastSeekAt > 1.5) setRevertTo(position.accessor.get())
                                lastSeekAt = now
                            })
                        }
                        hexpand
                        sensitive={canSeek}
                    />
                    <label
                        cssClasses={["mediaTime"]}
                        widthChars={6}
                        maxWidthChars={6}
                        label={trackLength.as(l => (l > 0 ? formatTime(l) : "--:--"))}
                    />
                </box>
            </box>
        </box>
    )
}

export function MediaSection() {
    // stable slot: the With mounts the card late (first player), which
    // would otherwise append it at the end of the pane instead of
    // keeping the top position
    return (
        <box orientation={Gtk.Orientation.VERTICAL}>
            <With value={activePlayer}>
                {p =>
                    p && (
                        <box cssClasses={["QSSection"]} orientation={Gtk.Orientation.VERTICAL}>
                            <Player player={p} />
                        </box>
                    )
                }
            </With>
        </box>
    )
}
