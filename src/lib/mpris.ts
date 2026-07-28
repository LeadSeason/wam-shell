import AstalMpris from "gi://AstalMpris?version=0.1"
import GLib from "gi://GLib?version=2.0"
import { Accessor, createBinding, createState } from "gnim"
import { execAsync } from "ags/process"
import Config from "../config"
import { isFile } from "./utils"

// Shared MPRIS state + helpers, used by the QS media section and the
// panel media widget/popup.

const mpris = AstalMpris.get_default()

export const players = createBinding(mpris, "players")

// the player shown everywhere: the playing one if any, else the first.
// A manual pick via the popup switcher overrides until that player goes
const [activePlayer, setActivePlayer] =
    createState<AstalMpris.Player | null>(null)
const [overridePlayer, setOverride] =
    createState<AstalMpris.Player | null>(null)

export { activePlayer }

/** pin a specific player (popup switcher); null returns to auto-pick */
export function overrideActivePlayer(player: AstalMpris.Player | null) {
    setOverride(player)
    pick()
}

const hooked: AstalMpris.Player[] = []
function pick() {
    const list = players.get()
    const override = overridePlayer.get()
    // players keep their MPRIS instance alive with empty metadata after
    // playback ends — a trackless player is not "active"
    const eligible = list.filter(p => p.title !== "")
    setActivePlayer(
        override && eligible.includes(override) ? override
            : eligible.find(p =>
                p.playbackStatus === AstalMpris.PlaybackStatus.PLAYING)
            ?? eligible[0] ?? null)
    for (const p of list) {
        if (!hooked.includes(p)) {
            hooked.push(p)
            createBinding(p, "playbackStatus").subscribe(pick)
            createBinding(p, "title").subscribe(pick)
        }
    }
}
players.subscribe(pick)
pick()

// GTK css can only load local files; remote (http) cover art is
// downloaded once into the cache dir and the local copy is used
function coverCachePath(url: string): string {
    const hash = GLib.compute_checksum_for_string(
        GLib.ChecksumType.MD5, url, -1)
    return `${Config.instanceCacheDir}/cover-${hash}`
}

/** cover art url as a state, re-resolving when the track changes */
export function coverState(player: AstalMpris.Player): Accessor<string> {
    const cover = createBinding(player, "coverArt")
    const [local, setLocal] = createState("")

    const update = () => {
        const url = cover.get()
        if (!url) return setLocal("")
        // astal gives bare paths (no file:// scheme) for local art
        if (url.startsWith("/")) return setLocal(`file://${url}`)
        if (!url.startsWith("http")) return setLocal(url)
        const path = coverCachePath(url)
        if (isFile(path)) return setLocal(`file://${path}`)
        setLocal("")
        execAsync(["curl", "-sL", "--fail", url, "-o", path])
            .then(() => setLocal(`file://${path}`))
            .catch((e) => console.warn("cover download failed:", e))
    }
    cover.subscribe(update)
    update()
    return local
}

export function formatTime(seconds: number): string {
    if (seconds < 0) seconds = 0
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return `${m}:${s.toString().padStart(2, "0")}`
}

export default mpris
