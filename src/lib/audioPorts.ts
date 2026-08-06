import { Accessor, createState } from "gnim"
import { execAsync } from "./metrics"

// Ports (speakers vs headphones on one card) come from pactl, not from
// astal — measured, not preferred:
//
// - Endpoint.set_route() does nothing. Setting it on a device with two
//   routes left the active route unchanged, exactly like the
//   set_is_default that the device rows already work around.
// - Endpoint.get_routes() does not describe the sink. It reports the
//   CARD's routes, so a bluetooth headset offered "Headphones" and
//   "Handsfree" — which are two profiles, not two ports of one sink.
//   pactl rejects the second outright ("No such entity"), and the
//   Cards section is where profiles already belong. Meanwhile it
//   MISSED a real port: the analog sink has both a speaker and a
//   headphone port, and astal listed one.
//
// pactl's json gets both right, and `pactl set-sink-port` genuinely
// switches (verified by switching the analog sink to its headphone port
// and back).
//
// Keyed on the pipewire object SERIAL, not the node id: pactl's "index"
// is the serial (it equals object.serial in every sink's properties),
// and astal exposes the same number as Endpoint.serial. The node id is
// a different number — the analog card happens to have id == serial
// == 54, which makes id look correct until a bluetooth or hdmi sink
// shows up as id 114 against index 209977.

export interface Port {
    name: string
    description: string
}

export interface PortInfo {
    active: string | null
    ports: Port[]
}

// endpoint id -> its ports. Empty until the first refresh
const [ports, setPorts] = createState(new Map<number, PortInfo>())
export const audioPorts: Accessor<Map<number, PortInfo>> = ports

interface PactlPort {
    name: string
    description: string
    availability: string
}
interface PactlNode {
    index: number
    active_port: string | null
    ports: PactlPort[] | null
}

function collect(raw: string, into: Map<number, PortInfo>) {
    let parsed: PactlNode[]
    try {
        parsed = JSON.parse(raw)
    } catch (e) {
        console.warn("audioPorts: could not parse pactl json:", e)
        return
    }
    for (const node of parsed ?? []) {
        const list = (node.ports ?? [])
            // "not available" is a port with nothing in it — an empty
            // headphone jack. Offering it would be offering silence.
            // "availability unknown" is the normal state of a port that
            // cannot be detected, so it stays
            .filter(p => p.availability !== "not available")
            .map(p => ({ name: p.name, description: p.description }))
        if (list.length) into.set(node.index, { active: node.active_port, ports: list })
    }
}

/** Re-read every sink and source port. Cheap enough for pane-open and
 *  after a switch; not something to poll */
export async function refreshPorts(): Promise<void> {
    try {
        const [sinks, sources] = await Promise.all([
            execAsync(["pactl", "-f", "json", "list", "sinks"]),
            execAsync(["pactl", "-f", "json", "list", "sources"]),
        ])
        const next = new Map<number, PortInfo>()
        collect(sinks, next)
        collect(sources, next)
        setPorts(next)
    } catch (e) {
        console.warn("audioPorts: pactl failed:", e)
    }
}

/** Switch one endpoint to one of its ports, then re-read so the pane
 *  shows what actually happened rather than what was asked for.
 *  @param serial the endpoint's pipewire object serial (Endpoint.serial) */
export async function setPort(
    serial: number,
    direction: "output" | "input",
    port: string,
): Promise<void> {
    try {
        await execAsync([
            "pactl",
            direction === "output" ? "set-sink-port" : "set-source-port",
            String(serial),
            port,
        ])
    } catch (e) {
        console.warn(`audioPorts: could not set port ${port} on ${serial}:`, e)
    }
    await refreshPorts()
}
