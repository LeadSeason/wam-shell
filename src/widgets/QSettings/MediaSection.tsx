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
    cycleLoop,
    eligiblePlayers,
    formatTime,
    lengthState,
    loopActive,
    loopIcon,
    loopLabel,
    overrideActivePlayer,
    playPauseExclusive,
    positionState,
    raisePlayer,
    scrollActivePlayer,
} from "../../lib/mpris"
import { isSmallCover } from "../../lib/coverArt"
import { sharing, enable as enableShareWatch } from "../../lib/screenShare"
import Config from "../../config"
import { isRtl } from "../../lib/utils"
import { pressable } from "../pressable"

function MediaButton({
    iconName,
    onPressed,
    sensitive,
    extraClasses = [],
    tooltipText,
}: {
    iconName: string | any
    onPressed: () => void
    sensitive?: any
    extraClasses?: string[] | any
    /** for controls whose icon alone cannot say which state they are in
     *  — the loop button's three modes differ by a small numeral */
    tooltipText?: string | any
}) {
    // extraClasses may be a plain array or an Accessor<string[]> (e.g.
    // the shuffle/loop active state)
    const classes = Array.isArray(extraClasses)
        ? ["mediaButton", ...extraClasses]
        : extraClasses.as((v: string[]) => ["mediaButton", ...v])
    return (
        <button
            cssClasses={classes}
            onClicked={onPressed}
            sensitive={sensitive}
            tooltipText={tooltipText}
        >
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
    // one binding, four consumers (icon, tooltip, active class, sensitive):
    // each createBinding is its own notify:: subscription, and the loop
    // button needs the same value four ways
    const loop = createBinding(player, "loopStatus")
    const localCover = coverState(player)
    // an arabic/hebrew title should hug the right edge, like the rest
    // of the shell does (see isRtl in lib/utils): the artist follows the
    // title's direction so the two lines share an edge even when the
    // artist name is latin
    const rtl = createComputed([title, artist], (t, a) => isRtl(t || a || ""))

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
            // the rounded clip for the full-bleed art: a widget
            // property, since gtk css has no overflow
            overflow={Gtk.Overflow.HIDDEN}
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
            {/* scroll anywhere on the card switches the focused player —
            except on the seeker, which seeks (its own controller wins) */}
            <Gtk.EventControllerScroll
                flags={Gtk.EventControllerScrollFlags.VERTICAL}
                onScroll={(_e, _dx, dy) => {
                    scrollActivePlayer(dy)
                    return true
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
            {/* the art IS the card: it fills the overlay, everything
            else rides a scrim on top of it. Fixed height whether art
            exists or not, so switching players never moves the content
            under the pointer */}
            <Gtk.Overlay hexpand>
                {/* the art, sharp and full bleed, edge to edge */}
                <box
                    cssClasses={localCover.as(c => [
                        "mediaBackdrop",
                        ...(c ? [] : ["noArt"]),
                        // a player that only ever hands over a thumbnail
                        // (chromium caps its mpris art at 150px, and
                        // lib/browserArt could not find the page): there
                        // are no pixels left to recover, so soften it
                        // rather than show a hard 4x upscale
                        ...(c && isSmallCover(c) ? ["smallArt"] : []),
                    ])}
                    css={localCover.as(c =>
                        c ? `background-image: url("${c.replace(/['\\]/g, "\\$&")}");` : "",
                    )}
                    tooltipText={"Focus player window"}
                >
                    <Gtk.GestureClick button={1} onPressed={() => raisePlayer(player)} />
                </box>
                {/* what the text sits on: a dark veil that is itself
                blurred, so its own edges feather into the artwork
                instead of ending on a line. Clipping a blurred COPY of
                the cover looked like a seam across the picture — the
                blur discontinuity showed wherever the art was bright.
                Blurring the veil instead leaves the cover untouched
                and still lifts the text off it */}
                <box
                    $type="overlay"
                    cssClasses={["mediaVeil"]}
                    valign={Gtk.Align.END}
                    heightRequest={128}
                    canTarget={false}
                />
                <box
                    $type="overlay"
                    cssClasses={rtl.as(r => ["mediaScrim", ...(r ? ["rtl"] : [])])}
                    orientation={Gtk.Orientation.VERTICAL}
                    spacing={6}
                    valign={Gtk.Align.FILL}
                >
                    <box vexpand />
                    <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand>
                        {/* title/artist: click focuses the player; scroll
                        switches players anywhere on the card (card-level
                        controller) */}
                        <box
                            orientation={Gtk.Orientation.VERTICAL}
                            tooltipText={eligiblePlayers.as(l =>
                                l.length > 1 ? "Scroll to switch player" : "Focus player window",
                            )}
                        >
                            <Gtk.GestureClick button={1} onPressed={() => raisePlayer(player)} />
                            {/* widthChars + maxWidthChars together pin the
                        size request: natural = max(width, min(text,
                        max)) = constant, so the popup never resizes
                        per track. long titles wrap onto a second line
                        (fits the cover row's 104px), ellipsize clips
                        what even two lines can't hold */}
                            <label
                                cssClasses={["mediaTitle"]}
                                xalign={rtl.as(r => (r ? 1 : 0))}
                                hexpand
                                maxWidthChars={40}
                                ellipsize={Pango.EllipsizeMode.END}
                                label={title.as(t => t || "Unknown title")}
                            />
                            <label
                                cssClasses={["mediaArtist"]}
                                xalign={rtl.as(r => (r ? 1 : 0))}
                                hexpand
                                maxWidthChars={40}
                                ellipsize={Pango.EllipsizeMode.END}
                                label={artist.as(a => a || player.identity || "")}
                            />
                        </box>
                        <box spacing={6} halign={Gtk.Align.CENTER}>
                            <MediaButton
                                extraClasses={createBinding(player, "shuffleStatus").as(s =>
                                    s === AstalMpris.Shuffle.ON ? ["active"] : [],
                                )}
                                iconName="media-playlist-shuffle-symbolic"
                                onPressed={() => {
                                    player.shuffleStatus =
                                        player.shuffleStatus === AstalMpris.Shuffle.ON
                                            ? AstalMpris.Shuffle.OFF
                                            : AstalMpris.Shuffle.ON
                                }}
                                sensitive={createBinding(player, "shuffleStatus").as(
                                    s => s !== AstalMpris.Shuffle.UNSUPPORTED,
                                )}
                            />
                            <MediaButton
                                iconName="media-skip-backward-symbolic"
                                onPressed={() => player.previous()}
                                sensitive={createBinding(player, "canGoPrevious")}
                            />
                            <MediaButton
                                extraClasses={["mediaPlay"]}
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
                            <MediaButton
                                extraClasses={loop.as(l => (loopActive(l) ? ["active"] : []))}
                                iconName={loop.as(loopIcon)}
                                tooltipText={loop.as(loopLabel)}
                                onPressed={() => cycleLoop(player)}
                                sensitive={loop.as(l => l !== AstalMpris.Loop.UNSUPPORTED)}
                            />
                        </box>
                    </box>
                    {/* seeker: full card width (the wiring is shared with
                the popup: bindSeekScale in lib/mpris) */}
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
                                {...pressable(() => {
                                    const r = revertTo.get()
                                    if (!player.canSeek || r < 0) return
                                    // toggle: a second click seeks forward again
                                    setRevertTo(position.accessor.get())
                                    position.seekTo(r)
                                    player.position = r
                                })}
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
            </Gtk.Overlay>
        </box>
    )
}

export function MediaSection() {
    // detection runs only once something actually hides on it (same
    // contract as the harvest pill: config off => no pw-dump monitor)
    if (Config.media.hideWhenScreenSharing) enableShareWatch()

    // "streaming mode": while screen sharing, hide the player entirely —
    // an open quick settings would leak title/artist/cover to viewers
    const visiblePlayer = createComputed([activePlayer, sharing], (p, s) =>
        s && Config.media.hideWhenScreenSharing ? null : p,
    )

    // stable slot: the With mounts the card late (first player), which
    // would otherwise append it at the end of the pane instead of
    // keeping the top position
    return (
        <box orientation={Gtk.Orientation.VERTICAL}>
            <With value={visiblePlayer}>
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
