import { test, eq } from "./framework"
import {
    parseVideoInputs,
    ignoredVideoInput,
    ignoredCaptureUser,
    parseCaptureUsers,
    graphBurstRouter,
} from "../src/lib/captureWatch"

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

// ---- captureUsersOf: camera + mic detection -----------------------------
//
// state lives on info, not in props, so these dumps use the extended
// builder; ids are array positions and links reference them as strings

function dumpWithInfo(...infos: { props: Record<string, unknown>; state?: string }[]): string {
    return JSON.stringify(infos.map((info, id) => ({ id, info })))
}

// pw-dump link props carry node ids as JSON numbers on current
// PipeWire, strings on older ones — the parser accepts both and the
// fixtures cover both spellings
const link = (
    out: number | string,
    input: number | string,
): { props: Record<string, unknown> } => ({
    props: { "link.output.node": out, "link.input.node": input },
})

const VIDEO_STREAM = {
    props: { "media.class": "Stream/Input/Video", "application.name": "obs", "node.name": "obs" },
    state: "running",
}
// what the v4l2/libcamera monitor creates: a source owned by a Device
const CAM_SOURCE = {
    props: {
        "media.class": "Video/Source",
        "device.id": "31",
        "device.api": "v4l2",
        "node.name": "Integrated Webcam",
    },
    state: "running",
}
// what the screencast portal creates: a source with no device behind it
const VIRTUAL_SOURCE = {
    props: { "media.class": "Video/Source", "node.name": "pipewire.screen-capture" },
    state: "running",
}
const AUDIO_STREAM = {
    props: {
        "media.class": "Stream/Input/Audio",
        "application.name": "firefox",
        "node.name": "firefox",
    },
    state: "running",
}
const MIC_SOURCE = {
    props: { "media.class": "Audio/Source", "device.id": "45", "node.name": "USB Microphone" },
    state: "running",
}
const SINK = {
    props: { "media.class": "Audio/Sink", "device.id": "44", "node.name": "Speakers" },
    state: "running",
}

test("captureWatch: a stream linked to a device-backed source is a camera user", () => {
    eq(parseCaptureUsers(dumpWithInfo(VIDEO_STREAM, CAM_SOURCE, link(1, 0))), {
        camera: [{ app: "obs", node: "obs" }],
        mic: [],
    })
})

test("captureWatch: a screencast (virtual source) is not a camera user", () => {
    // the portal grabs a source with no device.id — the mask still
    // sees the video stream, the camera dot must not light
    eq(parseCaptureUsers(dumpWithInfo(VIDEO_STREAM, VIRTUAL_SOURCE, link(1, 0))), {
        camera: [],
        mic: [],
    })
    eq(parseVideoInputs(dumpWithInfo(VIDEO_STREAM, VIRTUAL_SOURCE, link(1, 0))), [
        { app: "obs", node: "obs", media: "" },
    ])
})

test("captureWatch: an unlinked video stream is not a camera user", () => {
    // portal negotiation window: no link yet, nothing to attribute
    eq(parseCaptureUsers(dumpWithInfo(VIDEO_STREAM, CAM_SOURCE)), { camera: [], mic: [] })
})

test("captureWatch: a running stream linked to a source is a mic user", () => {
    eq(parseCaptureUsers(dumpWithInfo(AUDIO_STREAM, MIC_SOURCE, link(1, 0))), {
        camera: [],
        mic: [{ app: "firefox", node: "firefox" }],
    })
})

test("captureWatch: a sink monitor capture is not a mic user", () => {
    // desktop-audio recording (OBS capturing the output) rides the
    // sink's monitor ports — the link output node is the SINK
    eq(parseCaptureUsers(dumpWithInfo(AUDIO_STREAM, SINK, link(1, 0))), { camera: [], mic: [] })
})

test("captureWatch: a virtual source counts as mic use", () => {
    // processing chains (noise suppression): the app records the
    // chain's output source, the mic behind it is open either way
    const virtualMic = {
        props: { "media.class": "Audio/Source/Virtual", "node.name": "Noise source" },
        state: "running",
    }
    eq(parseCaptureUsers(dumpWithInfo(AUDIO_STREAM, virtualMic, link(1, 0))), {
        camera: [],
        mic: [{ app: "firefox", node: "firefox" }],
    })
})

test("captureWatch: suspended and idle streams are not recording", () => {
    // a paused call releases or never engages its source; only a
    // running stream counts — but a dump without node state must not
    // hide a capture (fail visible)
    const suspended = { ...AUDIO_STREAM, state: "suspended" }
    const idle = { ...AUDIO_STREAM, state: "idle" }
    const noState = {
        props: {
            "media.class": "Stream/Input/Audio",
            "application.name": "firefox",
            "node.name": "firefox",
        },
    }
    eq(parseCaptureUsers(dumpWithInfo(suspended, MIC_SOURCE, link(1, 0)))!.mic, [])
    eq(parseCaptureUsers(dumpWithInfo(idle, MIC_SOURCE, link(1, 0)))!.mic, [])
    eq(parseCaptureUsers(dumpWithInfo(noState, MIC_SOURCE, link(1, 0)))!.mic, [
        { app: "firefox", node: "firefox" },
    ])
})

test("captureWatch: camera and mic users are independent", () => {
    const out = parseCaptureUsers(
        dumpWithInfo(VIDEO_STREAM, CAM_SOURCE, link("1", 0), AUDIO_STREAM, MIC_SOURCE, link(4, 3)),
    )!
    eq(out.camera, [{ app: "obs", node: "obs" }])
    eq(out.mic, [{ app: "firefox", node: "firefox" }])
})

test("captureWatch: numeric link refs parse like string ones", () => {
    // current PipeWire emits the refs as JSON numbers; a regression
    // here silently empties every capture list
    const numeric = parseCaptureUsers(dumpWithInfo(AUDIO_STREAM, MIC_SOURCE, link(1, 0)))
    const stringy = parseCaptureUsers(dumpWithInfo(AUDIO_STREAM, MIC_SOURCE, link("1", "0")))
    eq(numeric, stringy)
    eq(numeric!.mic, [{ app: "firefox", node: "firefox" }])
})

test("captureWatch: an unparseable dump is null for capture users too", () => {
    eq(parseCaptureUsers("not json"), null)
})

test("captureWatch: the ignore list silences camera users like the mask", () => {
    const u = { app: "obs", node: "obs" }
    eq(ignoredCaptureUser(u, []), false)
    eq(ignoredCaptureUser(u, ["obs"]), true)
    eq(ignoredCaptureUser({ app: "", node: "HuenicornStream" }, []), true)
})

// ---- graphBurstRouter: which monitor bursts matter ----------------------

function feed(router: ReturnType<typeof graphBurstRouter>, objects: unknown[]) {
    // pw-dump -m emits pretty-printed JSON arrays; streamLines sees lines
    for (const line of JSON.stringify(objects, null, 2).split("\n")) router.onLine(line)
}

test("captureWatch: node/link bursts schedule, the watcher's own client churn does not", () => {
    let scheduled = 0
    const r = graphBurstRouter(() => scheduled++)
    // initial dump: a node, a client, a link
    feed(r, [
        {
            id: 1,
            type: "PipeWire:Interface:Node",
            info: { props: { "media.class": "Audio/Source" } },
        },
        { id: 2, type: "PipeWire:Interface:Client", info: { props: {} } },
        { id: 3, type: "PipeWire:Interface:Link", info: { props: { "link.output.node": "1" } } },
    ])
    eq(scheduled, 1)
    // the one-shot pw-dump evaluate() spawns is graph churn itself:
    // its client is added, then removed (removals carry no type)
    feed(r, [{ id: 90, type: "PipeWire:Interface:Client", info: { props: {} } }])
    feed(r, [{ id: 90, info: null }])
    eq(scheduled, 1) // the self-dump loop stays broken
    // a real node removal does trigger
    feed(r, [{ id: 1, info: null }])
    eq(scheduled, 2)
})

test("captureWatch: node state changes schedule, metadata churn does not", () => {
    let scheduled = 0
    const r = graphBurstRouter(() => scheduled++)
    feed(r, [{ id: 5, type: "PipeWire:Interface:Metadata", info: { props: {} } }])
    feed(r, [
        {
            id: 7,
            type: "PipeWire:Interface:Node",
            info: { props: { "media.class": "Stream/Input/Audio" }, state: "running" },
        },
    ])
    eq(scheduled, 1)
    // a removal of an object never seen is unclassifiable — schedule,
    // an unreadable change must not strand a state
    feed(r, [{ id: 999, info: null }])
    eq(scheduled, 2)
})

test("captureWatch: brackets inside prop values do not split a burst", () => {
    let scheduled = 0
    const r = graphBurstRouter(() => scheduled++)
    feed(r, [
        {
            id: 8,
            type: "PipeWire:Interface:Node",
            info: { props: { "node.name": "weird ] [ name" } },
        },
    ])
    eq(scheduled, 1)
})

test("captureWatch: an unreadable burst schedules once and does not wedge the router", () => {
    let scheduled = 0
    const r = graphBurstRouter(() => scheduled++)
    r.onLine("[broken")
    r.onLine("]")
    eq(scheduled, 1)
    feed(r, [{ id: 1, type: "PipeWire:Interface:Node", info: {} }])
    eq(scheduled, 2)
})
