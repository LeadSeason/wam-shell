import { Astal, Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import Pango from "gi://Pango?version=1.0"
import Graphene from "gi://Graphene?version=1.0"
import AstalMpris from "gi://AstalMpris?version=0.1"
import app from "ags/gtk4/app"
import { For, With, createBinding, createComputed, createRoot, createState } from "gnim"
import CommandRegistry from "../lib/requestHandler"
import { timeoutAdd, sourceRemove } from "../lib/metrics"
import { hideOnFocusLoss } from "../lib/popupFocus"
import {
    activePlayer,
    bindSeekScale,
    coverState,
    eligiblePlayers,
    formatTime,
    lengthState,
    overrideActivePlayer,
    playPauseExclusive,
    positionState,
} from "../lib/mpris"
import { createIconResolver } from "../lib/appIcon"
import Config from "../config"

const registry = CommandRegistry.get_default()

/** where the pill was clicked: the popup drops directly below it */
export const [popupAnchor, setPopupAnchor] = createState<{
    x: number
    monitor: Gdk.Monitor
} | null>(null)

// the popup window stays mounted (hidden) after close so its reveal
// animation can play. PopupContent is only mounted while visible so its
// player subscriptions (position, cover, …) are torn down on close.
const [popupVisible, setPopupVisible] = createState(false)

// the popup appears where the pill is: centered for the center section,
// top-left/top-right for the side sections
function mediaAnchor(): number {
    const { TOP, LEFT, RIGHT } = Astal.WindowAnchor
    const zones = new Set<string>()
    for (const p of Config.panels) {
        if (p.left.includes("media")) zones.add("left")
        if (p.center.includes("media")) zones.add("center")
        if (p.right.includes("media")) zones.add("right")
    }
    if (zones.has("center")) return TOP
    if (zones.has("left") && !zones.has("right")) return TOP | LEFT
    if (zones.has("right") && !zones.has("left")) return TOP | RIGHT
    // legacy layout (no [[panel]]) puts media in the right section;
    // media on both sides is ambiguous — center it
    return zones.size === 0 ? TOP | RIGHT : TOP
}

// the pin this popup made (if any): hide() only clears its own pin,
// never one made from the quick settings card or the panel pill
let popupPin: AstalMpris.Player | null = null

function PlayerSwitcher() {
    return (
        <box cssClasses={["switcher"]} spacing={6} visible={eligiblePlayers.as(l => l.length > 1)}>
            <label label={"Player"} cssClasses={["section"]} xalign={0} hexpand />
            <For each={eligiblePlayers}>
                {p => (
                    <button
                        cssClasses={activePlayer.as(a => (a === p ? ["active"] : [""]))}
                        onClicked={() => {
                            popupPin = p
                            overrideActivePlayer(p)
                        }}
                    >
                        <label
                            label={p.identity}
                            maxWidthChars={12}
                            ellipsize={Pango.EllipsizeMode.END}
                        />
                    </button>
                )}
            </For>
        </box>
    )
}

function PopupContent({ player }: { player: AstalMpris.Player }) {
    const localCover = coverState(player)
    const status = createBinding(player, "playbackStatus")
    const resolveIcon = createIconResolver(
        Gtk.IconTheme.get_for_display(Gdk.Display.get_default()!),
    )

    // client-side clock — players that do not track Position (firefox
    // reports 0) still get a moving bar
    const position = positionState(player)
    // last known positive length: survives players dropping mpris:length
    // mid-track; 0 = the player never reported a duration (firefox)
    const length = lengthState(player)
    const canSeek = createBinding(player, "canSeek")

    const shuffleClass = createBinding(player, "shuffleStatus").as(s =>
        s === AstalMpris.Shuffle.ON ? ["active"] : [""],
    )
    const loopClass = createBinding(player, "loopStatus").as(l =>
        l === AstalMpris.Loop.TRACK || l === AstalMpris.Loop.PLAYLIST ? ["active"] : [""],
    )

    function cycleLoop() {
        switch (player.loopStatus) {
            case AstalMpris.Loop.NONE:
                player.loopStatus = AstalMpris.Loop.TRACK
                break
            case AstalMpris.Loop.TRACK:
                player.loopStatus = AstalMpris.Loop.PLAYLIST
                break
            default:
                player.loopStatus = AstalMpris.Loop.NONE
        }
    }

    return (
        <box
            cssClasses={["mediaPopup"]}
            orientation={Gtk.Orientation.VERTICAL}
            spacing={10}
            widthRequest={360}
        >
            {/* player identity header */}
            <box halign={Gtk.Align.CENTER} spacing={6}>
                <image
                    iconName={createBinding(player, "entry").as(
                        e =>
                            // browsers leave DesktopEntry empty; identity
                            // ("Brave") resolves via fuzzy match instead
                            resolveIcon(e || player.identity) ?? "audio-x-generic-symbolic",
                    )}
                    pixelSize={20}
                />
                <label cssClasses={["identity"]} label={player.identity} />
            </box>
            {/* big centered art; empty when the player has no cover */}
            <box halign={Gtk.Align.CENTER}>
                <With value={localCover}>
                    {c =>
                        c ? (
                            <box
                                cssClasses={["coverBig"]}
                                css={`
                                    background-image: url("${c}");
                                `}
                            />
                        ) : (
                            <box cssClasses={["coverBig", "fallback"]} />
                        )
                    }
                </With>
            </box>
            <label
                cssClasses={["title"]}
                label={createBinding(player, "title").as(t => t || "Unknown title")}
                halign={Gtk.Align.CENTER}
                maxWidthChars={30}
                ellipsize={Pango.EllipsizeMode.END}
            />
            <label
                cssClasses={["artist"]}
                label={createBinding(player, "artist").as(a => a || "")}
                halign={Gtk.Align.CENTER}
                maxWidthChars={34}
                ellipsize={Pango.EllipsizeMode.END}
            />
            <box spacing={6}>
                <label
                    cssClasses={["time"]}
                    label={createComputed([position.accessor, position.known], (p, k) =>
                        k ? formatTime(p) : "--:--",
                    )}
                />
                <Gtk.Scale
                    $={self => bindSeekScale(self, player, position)}
                    hexpand
                    sensitive={canSeek}
                />
                <label
                    cssClasses={["time"]}
                    label={length.as(l => (l > 0 ? formatTime(l) : "--:--"))}
                />
            </box>
            <box cssClasses={["controls"]} spacing={6} halign={Gtk.Align.CENTER}>
                <button
                    cssClasses={loopClass}
                    sensitive={createBinding(player, "loopStatus").as(
                        l => l !== AstalMpris.Loop.UNSUPPORTED,
                    )}
                    onClicked={cycleLoop}
                >
                    <image iconName="media-playlist-repeat-symbolic" />
                </button>
                <button
                    onClicked={() => player.previous()}
                    sensitive={createBinding(player, "canGoPrevious")}
                >
                    <image iconName="media-skip-backward-symbolic" />
                </button>
                <button
                    cssClasses={["play"]}
                    onClicked={() => playPauseExclusive(player)}
                    sensitive={createBinding(player, "canPlay")}
                >
                    <image
                        pixelSize={28}
                        iconName={status.as(s =>
                            s === AstalMpris.PlaybackStatus.PLAYING
                                ? "media-playback-pause-symbolic"
                                : "media-playback-start-symbolic",
                        )}
                    />
                </button>
                <button
                    onClicked={() => player.next()}
                    sensitive={createBinding(player, "canGoNext")}
                >
                    <image iconName="media-skip-forward-symbolic" />
                </button>
                <button
                    cssClasses={shuffleClass}
                    sensitive={createBinding(player, "shuffleStatus").as(
                        s => s !== AstalMpris.Shuffle.UNSUPPORTED,
                    )}
                    onClicked={() => {
                        player.shuffleStatus =
                            player.shuffleStatus === AstalMpris.Shuffle.ON
                                ? AstalMpris.Shuffle.OFF
                                : AstalMpris.Shuffle.ON
                    }}
                >
                    <image iconName="media-playlist-shuffle-symbolic" />
                </button>
            </box>
            <PlayerSwitcher />
        </box>
    )
}

// the request is registered eagerly (import side effect), but the
// window is built lazily on first toggle — no need to construct it
// at shell startup
let win: Astal.Window | null = null
let rev: Gtk.Revealer | null = null
let hideSource: number | null = null

function show() {
    if (hideSource !== null) {
        sourceRemove(hideSource)
        hideSource = null
    }
    // mount PopupContent (and its seek poll) before presenting
    setPopupVisible(true)
    // drop directly below the pill when its position is known
    const anchor = popupAnchor.get()
    if (anchor) win!.gdkmonitor = anchor.monitor
    win!.present()
    rev!.revealChild = true
}

function hide() {
    rev!.revealChild = false
    if (hideSource !== null) sourceRemove(hideSource)
    hideSource = timeoutAdd("mediaPopup:hide", GLib.PRIORITY_DEFAULT, 200, () => {
        hideSource = null
        win!.hide()
        // unmount PopupContent now the slide-out has played: this tears
        // down its player subscriptions instead of keeping them alive
        setPopupVisible(false)
        // only clear a pin this popup made; pins from the quick
        // settings card or the panel pill stay
        if (popupPin && activePlayer.get() === popupPin) overrideActivePlayer(null)
        popupPin = null
        return GLib.SOURCE_REMOVE
    })
}

registry.register({
    name: ["media", "mediaPopup"],
    description: "Toggle the media controls popup",
    main: () => {
        ensureWindow()
        if (win!.is_visible()) {
            hide()
            return "hidden"
        }
        show()
        return "shown"
    },
})

function onKey(_e: Gtk.EventControllerKey, keyValue: number) {
    if (keyValue === Gdk.KEY_Escape) hide()
}

function onClick(_e: Gtk.GestureClick, _: number, x: number, y: number) {
    const [, rect] = win!.get_child()!.compute_bounds(win!)
    if (!rect.contains_point(new Graphene.Point({ x, y }))) hide()
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
                    name="MediaPopup"
                    class="MediaPopup"
                    namespace="media-popup"
                    anchor={popupAnchor.as(a =>
                        a ? Astal.WindowAnchor.TOP | Astal.WindowAnchor.LEFT : mediaAnchor(),
                    )}
                    marginTop={30}
                    marginRight={12}
                    // pill center minus half the popup width (360), but
                    // never past the monitor's right edge — the harvest
                    // popup clamps the same way
                    marginLeft={popupAnchor.as(a => {
                        if (!a) return 12
                        const POPUP_W = 360 + 24 // request + horizontal margins
                        const monW = a.monitor.get_geometry().width
                        return Math.max(0, Math.min(Math.round(a.x - 180), monW - POPUP_W))
                    })}
                    // ON_DEMAND, not EXCLUSIVE: the grab stole input from
                    // other surfaces; focus loss closes instead
                    keymode={Astal.Keymode.ON_DEMAND}
                    visible={false}
                >
                    <Gtk.EventControllerKey onKeyPressed={onKey} />
                    <Gtk.GestureClick onPressed={onClick} />
                    <revealer
                        $={self => {
                            rev = self
                        }}
                        transitionDuration={200}
                        transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
                    >
                        <With
                            value={createComputed([activePlayer, popupVisible], (p, vis) =>
                                vis ? p : null,
                            )}
                        >
                            {player =>
                                player ? (
                                    <PopupContent player={player} />
                                ) : (
                                    <box
                                        cssClasses={["mediaPopup", "empty"]}
                                        halign={Gtk.Align.CENTER}
                                    >
                                        <image iconName="audio-x-generic-symbolic" pixelSize={32} />
                                        <label label={"Nothing playing"} />
                                    </box>
                                )
                            }
                        </With>
                    </revealer>
                </window>
            ) as Gtk.Window,
        )
    })
}
