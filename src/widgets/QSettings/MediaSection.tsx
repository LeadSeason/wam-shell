import AstalMpris from "gi://AstalMpris?version=0.1";
import Gtk from "gi://Gtk?version=4.0";
import GLib from "gi://GLib?version=2.0";
import Pango from "gi://Pango?version=1.0";
import { execAsync } from "ags/process";
import { createBinding, createState, With } from "gnim";
import Config from "../../config";
import { isFile } from "../../lib/utils";

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
    const cover = createBinding(player, "coverArt")

    // GTK css can only load local files; remote (http) cover art is
    // downloaded once into the cache dir and the local copy is used
    const [localCover, setLocalCover] = createState("")
    const resolveCover = (url: string) => {
        if (!url) return setLocalCover("")
        // astal gives bare paths (no file:// scheme) for local art
        if (url.startsWith("/")) return setLocalCover(`file://${url}`)
        if (!url.startsWith("http")) return setLocalCover(url)
        const hash = GLib.compute_checksum_for_string(
            GLib.ChecksumType.MD5, url, -1)
        const path = `${Config.instanceCacheDir}/cover-${hash}`
        if (isFile(path)) return setLocalCover(`file://${path}`)
        execAsync(["curl", "-sL", "--fail", url, "-o", path])
            .then(() => setLocalCover(`file://${path}`))
            .catch((e) => console.error("cover download failed:", e))
    }
    cover.subscribe(() => resolveCover(cover.get()))
    resolveCover(cover.get())

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
    const mpris = AstalMpris.get_default()
    const players = createBinding(mpris, "players")
    const [active, setActive] = createState<AstalMpris.Player | null>(null)

    // prefer the playing player over a paused one; re-pick whenever the
    // list or any player's playback status changes
    const hooked: AstalMpris.Player[] = []
    const pick = (list: AstalMpris.Player[]) => {
        setActive(list.find(p =>
            p.playbackStatus === AstalMpris.PlaybackStatus.PLAYING)
            ?? list[0] ?? null)
        for (const p of list) {
            if (!hooked.includes(p)) {
                hooked.push(p)
                createBinding(p, "playbackStatus")
                    .subscribe(() => pick(players.get()))
            }
        }
    }
    players.subscribe(() => pick(players.get()))
    pick(players.get())

    return <With value={active}>
        {(p) => p &&
            <box cssClasses={["QSSection"]} orientation={Gtk.Orientation.VERTICAL}>
                <Player player={p} />
            </box>}
    </With>
}
