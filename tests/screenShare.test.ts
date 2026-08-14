import { test, eq } from "./framework"
import { parseVideoInputs, ignoredVideoInput } from "../src/lib/screenShare"

// minimal pw-dump shape: an array of objects with info.props
function dumpWith(...propsList: Record<string, string>[]): string {
    return JSON.stringify(propsList.map((props, id) => ({ id, info: { props } })))
}

const OBS = {
    "media.class": "Stream/Input/Video",
    "application.name": "obs",
    "node.name": "obs",
    "media.name": "Screen Cast",
}

test("screenShare: parseVideoInputs keeps only video input streams", () => {
    const v = parseVideoInputs(
        dumpWith({ "media.class": "Audio/Sink", "node.name": "alsa_out" }, OBS, {
            "media.class": "Stream/Output/Audio",
            "application.name": "firefox",
        }),
    )
    eq(v, [{ app: "obs", node: "obs", media: "Screen Cast" }])
})

test("screenShare: a pw-stream client may set node.name without application.name", () => {
    const v = parseVideoInputs(
        dumpWith({
            "media.class": "Stream/Input/Video",
            "node.name": "HuenicornStream",
            "media.name": "HuenicornStream",
        }),
    )
    eq(v, [{ app: "", node: "HuenicornStream", media: "HuenicornStream" }])
})

test("screenShare: an unparseable dump is null, not an empty list", () => {
    // null = caller falls back to the raw match count; [] would silently unmask
    eq(parseVideoInputs("not json"), null)
    eq(parseVideoInputs(""), null)
})

test("screenShare: ignore matches application.name and node.name, case-insensitively", () => {
    // entries arrive lowercased from config (tested in config.test.ts);
    // the stream's own casing is normalized here
    const v = parseVideoInputs(dumpWith(OBS))![0]
    eq(ignoredVideoInput(v, []), false)
    eq(ignoredVideoInput(v, ["obs"]), true)
    eq(ignoredVideoInput(v, ["firefox"]), false)
    const loud = parseVideoInputs(
        dumpWith({ ...OBS, "application.name": "OBS", "node.name": "Obs" }),
    )![0]
    eq(ignoredVideoInput(loud, ["obs"]), true)
    // node.name-only streams are matched by their node name
    const h = parseVideoInputs(
        dumpWith({ "media.class": "Stream/Input/Video", "node.name": "AmbientLightStream" }),
    )![0]
    eq(ignoredVideoInput(h, ["ambientlightstream"]), true)
    eq(ignoredVideoInput(h, ["ambientlight"]), false)
})

test("screenShare: ambient grabbers are always ignored, config or not", () => {
    // huenicorn's pw-stream sets node.name only, its client sets
    // application.name — both spellings are in ALWAYS_IGNORED
    const byNode = parseVideoInputs(
        dumpWith({ "media.class": "Stream/Input/Video", "node.name": "HuenicornStream" }),
    )![0]
    const byApp = parseVideoInputs(
        dumpWith({ "media.class": "Stream/Input/Video", "application.name": "Huenicorn" }),
    )![0]
    eq(ignoredVideoInput(byNode, []), true)
    eq(ignoredVideoInput(byApp, []), true)
    // ...while a real screencaster still counts
    const obs = parseVideoInputs(dumpWith(OBS))![0]
    eq(ignoredVideoInput(obs, []), false)
})
