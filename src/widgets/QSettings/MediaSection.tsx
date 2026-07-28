import AstalMpris from "gi://AstalMpris?version=0.1";
import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango?version=1.0";
import { createBinding, With } from "gnim";
import { activePlayer, coverState } from "../../lib/mpris";

function MediaButton({ iconName, onPressed, sensitive }: {
    iconName: string
    onPressed: () => void
    sensitive?: any
}) {
    return <button
        cssClasses={["mediaButton"]}
        onClicked={onPressed}
        sensitive={sensitive}
    >
        <image iconName={iconName} />
    </button>
}

function Player({ player }: { player: AstalMpris.Player }) {
    const title = createBinding(player, "title")
    const artist = createBinding(player, "artist")
    const status = createBinding(player, "playbackStatus")
    const localCover = coverState(player)

    return <box cssClasses={["mediaPlayer"]} spacing={8}>
        <box
            cssName="button"
            tooltipText="Focus player window"
            sensitive={createBinding(player, "canRaise")}
        >
            <Gtk.GestureClick
                button={1}
                onPressed={() => player.raise()}
            />
            <With value={localCover}>
                {(c) => c
                    ? <box
                        cssClasses={["mediaCover"]}
                        css={`background-image: url('${c}');`}
                    />
                    : <box cssClasses={["mediaCover", "mediaCoverFallback"]}>
                        <image iconName="audio-x-generic-symbolic" />
                    </box>}
            </With>
        </box>
        <box orientation={Gtk.Orientation.VERTICAL} hexpand valign={Gtk.Align.CENTER}>
            <label
                cssClasses={["mediaTitle"]}
                xalign={0}
                maxWidthChars={24}
                ellipsize={Pango.EllipsizeMode.END}
                label={title.as(t => t || "Unknown title")}
            />
            <label
                cssClasses={["mediaArtist"]}
                xalign={0}
                maxWidthChars={28}
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
            iconName={status.as(s => s === AstalMpris.PlaybackStatus.PLAYING
                ? "media-playback-pause-symbolic"
                : "media-playback-start-symbolic")}
            onPressed={() => player.play_pause()}
            sensitive={createBinding(player, "canPlay")}
        />
        <MediaButton
            iconName="media-skip-forward-symbolic"
            onPressed={() => player.next()}
            sensitive={createBinding(player, "canGoNext")}
        />
    </box>
}

export function MediaSection() {
    return <With value={activePlayer}>
        {(p) => p &&
            <box cssClasses={["QSSection"]} orientation={Gtk.Orientation.VERTICAL}>
                <Player player={p} />
            </box>}
    </With>
}
