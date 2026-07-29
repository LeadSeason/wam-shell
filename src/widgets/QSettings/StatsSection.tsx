import Gtk from "gi://Gtk?version=4.0";
import { Accessor, createComputed, With, onCleanup } from "gnim";
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
    // a single DrawingArea replaces one <box> child per sample (up to 64
    // per stat), each tick rebuilding the lot. The colour comes from the
    // widget's CSS `color` (.statCpu/.statRam/.statGpu).
    return <Gtk.DrawingArea
        cssClasses={["statGraph", className]}
        valign={Gtk.Align.END}
        halign={Gtk.Align.END}
        hexpand={hexpand}
        $={(self) => {
            self.set_content_height(height)
            const redraw = () => {
                // 2px per bar natural width (matches the old min-width: 2px
                // child boxes); hexpand grows it and bars spread to fill
                self.set_content_width(Math.max(1, hist.get().length) * 2)
                self.queue_draw()
            }
            self.set_draw_func((_da: Gtk.DrawingArea, cr: any, w: number, h: number) => {
                const samples = hist.get()
                const n = samples.length
                if (n === 0) return
                const c = self.get_color()
                cr.setSourceRGBA(c.red, c.green, c.blue, c.alpha)
                const bw = w / n
                for (let i = 0; i < n; i++) {
                    const bh = Math.max(1, Math.round(samples[i].v / 100 * h))
                    cr.rectangle(i * bw, h - bh, Math.max(1, bw), bh)
                }
                cr.fill()
            })
            const unsub = hist.subscribe(redraw)
            onCleanup(unsub)
            redraw()
        }}
    />
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
