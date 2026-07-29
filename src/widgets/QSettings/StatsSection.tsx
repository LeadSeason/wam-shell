import Gtk from "gi://Gtk?version=4.0";
import { Accessor, createComputed, For, With } from "gnim";
import {
    cpu, ram, gpu, gpuTemp, netDown, netUp,
    cpuHist, ramHist, gpuHist, formatRate,
    ramSize, vram, loadAvg,
} from "../../lib/sysstats";

const GRAPH_HEIGHT = 24

export function Graph({ hist, className, height = GRAPH_HEIGHT, hexpand = true }: {
    hist: Accessor<{ v: number }[]>
    className: string
    height?: number
    hexpand?: boolean
}) {
    return <box
        cssClasses={["statGraph", className]}
        valign={Gtk.Align.END}
        halign={Gtk.Align.END}
        hexpand={hexpand}
    >
        <For each={hist}>
            {(s) => <box
                valign={Gtk.Align.END}
                css={`min-height: ${
                    Math.max(1, Math.round(s.v / 100 * height))}px;`}
            />}
        </For>
    </box>
}

function StatRow({ name, value, hist, className }: {
    name: string
    value: Accessor<string> | string
    hist: Accessor<{ v: number }[]>
    className: string
}) {
    return <box cssClasses={["statsRow"]} spacing={8}>
        <label label={name} cssClasses={["statName"]} xalign={0} />
        <label label={value} cssClasses={["statValue"]} />
        <Graph hist={hist} className={className} />
    </box>
}

export function StatsSection() {
    return <box cssClasses={["QSSection", "statsSection"]}
        orientation={Gtk.Orientation.VERTICAL} spacing={8}>
        <StatRow
            name="CPU"
            className="statCpu"
            value={createComputed([cpu, loadAvg],
                (c, l) => `${c}%  load ${l.toFixed(2)}`)}
            hist={cpuHist}
        />
        <StatRow
            name="RAM"
            className="statRam"
            value={ramSize.as(([used, total]) =>
                `${ram.get()}%  ${used}/${total} GB`)}
            hist={ramHist}
        />
        {/* gate on null-ness only: With re-executes on every value
            change, and gpu updates every tick — the whole row (labels,
            graph) was rebuilt per poll */}
        <With value={gpu.as(g => g !== null)}>
            {(present) => present &&
                <StatRow
                    name="GPU"
                    className="statGpu"
                    value={createComputed([gpu, gpuTemp, vram],
                        (g, t, [used, total]) =>
                            `${g}% ${t}°C  ${used}/${total} MiB`)}
                    hist={gpuHist}
                />}
        </With>
        <box cssClasses={["statsRow"]} spacing={8}>
            <label label="NET" cssClasses={["statName"]} xalign={0} />
            <label
                cssClasses={["statValue", "statNet"]}
                label={netDown.as(v => `↓ ${formatRate(v)}`)}
            />
            <label
                cssClasses={["statValue", "statNet"]}
                label={netUp.as(v => `↑ ${formatRate(v)}`)}
            />
        </box>
    </box>
}
