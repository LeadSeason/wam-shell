import AstalMpris from "gi://AstalMpris?version=0.1"
import Gdk from "gi://Gdk?version=4.0"
import Pango from "gi://Pango?version=1.0"
import { Gtk } from "ags/gtk4"
import { With, createBinding, createComputed, onCleanup } from "gnim"
import Config from "../../../config"
import CommandRegistry from "../../../lib/requestHandler"
import { activePlayer } from "../../../lib/mpris"
import { createIconResolver } from "../../../lib/appIcon"
import { popupAnchor, setPopupAnchor } from "../../mediaPopup"

const registry = CommandRegistry.get_default()

function MediaWidget({
    player,
    monitor,
    resolveIcon,
}: {
    player: AstalMpris.Player
    monitor: Gdk.Monitor
    resolveIcon: (name: string | null | undefined) => string | null
}) {
    const status = createBinding(player, "playbackStatus")
    const position = createBinding(player, "position")
    const length = createBinding(player, "length")

    const label = createComputed(
        [createBinding(player, "title"), createBinding(player, "artist")],
        (title, artist) =>
            artist ? `${title || "Unknown title"} - ${artist}` : title || player.identity || "",
    )

    let mediaBox: Gtk.Box

    return (
        <box
            cssClasses={["media"]}
            orientation={Gtk.Orientation.VERTICAL}
            $={self => {
                mediaBox = self
            }}
        >
            <box>
                <box spacing={6}>
                    {/* left click: popup below the pill, right click: play/pause */}
                    <Gtk.GestureClick
                        button={1}
                        onPressed={() => {
                            const [, x] = mediaBox.translate_coordinates(mediaBox.get_root(), 0, 0)
                            setPopupAnchor({
                                x: x + mediaBox.get_width() / 2,
                                monitor,
                            })
                            registry.execute(["media"], true)
                        }}
                    />
                    <Gtk.GestureClick button={3} onPressed={() => player.play_pause()} />
                    <image
                        iconName={createBinding(player, "entry").as(
                            e =>
                                // browsers leave DesktopEntry empty; identity
                                // ("Brave") resolves via fuzzy match instead
                                resolveIcon(e || player.identity) ?? "audio-x-generic-symbolic",
                        )}
                    />
                    <label
                        label={label}
                        maxWidthChars={Config.media.maxWidth}
                        ellipsize={Pango.EllipsizeMode.END}
                    />
                </box>
                {Config.media.showControls && (
                    <>
                        <button
                            onClicked={() => player.previous()}
                            sensitive={createBinding(player, "canGoPrevious")}
                        >
                            <image iconName="media-skip-backward-symbolic" />
                        </button>
                        <button
                            onClicked={() => player.play_pause()}
                            sensitive={createBinding(player, "canPlay")}
                        >
                            <image
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
                    </>
                )}
            </box>
            {/* progress through the track: fills left to right so the pill
            shows where playback begins and ends */}
            <Gtk.DrawingArea
                cssClasses={["mediaProgress"]}
                heightRequest={2}
                $={self => {
                    const unsub = position.subscribe(() => self.queue_draw())
                    onCleanup(unsub)
                    self.set_draw_func((area, cr: any, w: number, h: number) => {
                        const c = area.get_color()
                        cr.setSourceRGBA(c.red, c.green, c.blue, 0.25)
                        cr.rectangle(0, 0, w, h)
                        cr.fill()
                        const len = length.get()
                        if (len > 0) {
                            const frac = Math.min(1, Math.max(0, position.get() / len))
                            cr.setSourceRGBA(c.red, c.green, c.blue, 0.95)
                            cr.rectangle(0, 0, w * frac, h)
                            cr.fill()
                        }
                    })
                }}
            />
        </box>
    )
}

export default function Media({ monitor }: { monitor: Gdk.Monitor }) {
    const resolveIcon = createIconResolver(Gtk.IconTheme.get_for_display(monitor.display))
    // stable slot: the With mounts the widget late (first player), which
    // would otherwise append it at the end of the bar section instead of
    // keeping its configured position
    return (
        <box visible={activePlayer.as(p => p !== null)}>
            <With value={activePlayer}>
                {player =>
                    player && (
                        <MediaWidget player={player} monitor={monitor} resolveIcon={resolveIcon} />
                    )
                }
            </With>
        </box>
    )
}
