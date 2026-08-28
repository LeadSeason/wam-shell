import { test, eq } from "./framework"
import { dedupePlayers, type DedupablePlayer } from "../src/lib/mprisDedup"

/** a fake player; `pid` is what it publishes as kde:pid, not its own */
function player(busName: string, identity: string, title: string, pid?: number): DedupablePlayer {
    return {
        busName,
        identity,
        title,
        get_meta: key =>
            key === "kde:pid" && pid != null ? { deep_unpack: <T>() => pid as T } : null,
    }
}

const names = (list: DedupablePlayer[]) => list.map(p => p.busName)

const NATIVE = "org.mpris.MediaPlayer2.brave.instance18798"
const PBI = "org.mpris.MediaPlayer2.plasma-browser-integration"
// the extension owns a per-instance name too, suffixed with ITS OWN pid
const PBI_INSTANCE = "org.mpris.MediaPlayer2.plasma-browser-integration-19328"

test("dedupe: both Plasma Browser Integration names collapse into the native player", () => {
    // the shape a playing youtube tab actually puts on the bus: three
    // names, one tab. Titles differ — native carries the window's
    // tab-count and site suffix, the integration's is bare — so
    // identity+title alone never catches them
    const list = [
        player(NATIVE, "Brave", "(1) A Video - YouTube"),
        player(PBI, "Brave", "A Video ", 18798),
        player(PBI_INSTANCE, "Brave", "A Video ", 18798),
    ]
    eq(names(dedupePlayers(list)), [NATIVE])
})

test("dedupe: the integration survives when the native player is not on the bus", () => {
    // no .instance<pid> name to match against: the two integration
    // names are pure twins, so identity+title collapses them to one
    const list = [
        player(PBI, "Firefox", "A Video", 4242),
        player(PBI_INSTANCE, "Firefox", "A Video", 4242),
    ]
    eq(names(dedupePlayers(list)), [PBI])
})

test("dedupe: a player publishing its OWN pid is not its own duplicate", () => {
    const self = player("org.mpris.MediaPlayer2.kdeapp.instance777", "KDE App", "A Track", 777)
    eq(names(dedupePlayers([self])), ["org.mpris.MediaPlayer2.kdeapp.instance777"])
})

test("dedupe: one process, several bridge names, same identity and track", () => {
    const list = [
        player("org.mpris.MediaPlayer2.mpv.instance1234", "mpv", "A Track"),
        player("org.mpris.MediaPlayer2.mpv.instance-abc", "mpv", "A Track"),
        player("org.mpris.MediaPlayer2.mpv", "mpv", "A Track"),
    ]
    eq(names(dedupePlayers(list)), ["org.mpris.MediaPlayer2.mpv.instance1234"])
})

test("dedupe: genuinely different players are all kept", () => {
    const list = [
        player(NATIVE, "Brave", "(1) A Video - YouTube"),
        player(PBI, "Brave", "A Video ", 18798),
        player("org.mpris.MediaPlayer2.spotify", "Spotify", "A Song"),
        player("org.mpris.MediaPlayer2.mpv.instance999", "mpv", "A Clip"),
    ]
    eq(names(dedupePlayers(list)), [
        NATIVE,
        "org.mpris.MediaPlayer2.spotify",
        "org.mpris.MediaPlayer2.mpv.instance999",
    ])
})

test("dedupe: an unrelated kde:pid keeps the player", () => {
    // a KDE-native player on a bus with a browser: its pid matches no
    // .instance<pid> name, so it is nobody's duplicate
    const list = [
        player(NATIVE, "Brave", "(1) A Video - YouTube"),
        player("org.mpris.MediaPlayer2.elisa", "Elisa", "A Song", 5555),
    ]
    eq(names(dedupePlayers(list)), [NATIVE, "org.mpris.MediaPlayer2.elisa"])
})
