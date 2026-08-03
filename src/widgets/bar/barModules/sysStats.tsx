import { Accessor, With, createComputed, onCleanup } from "gnim"
import Gtk from "gi://Gtk?version=4.0"
import {
    cpu,
    ram,
    gpu,
    gpuTemp,
    netDown,
    netUp,
    formatRate,
    cpuHist,
    ramHist,
    gpuHist,
    ramSize,
    vram,
    loadAvg,
} from "../../../lib/sysstats"

const GRAPH_HEIGHT = 24

function Graph({
    hist,
    className,
    height = GRAPH_HEIGHT,
    hexpand = true,
}: {
    hist: Accessor<{ v: number }[]>
    className: string
    height?: number
    hexpand?: boolean
}) {
    // a single DrawingArea replaces one <box> child per sample (up to 64
    // per stat), each tick rebuilding the lot. The colour comes from the
    // widget's CSS `color` (.statCpu/.statRam/.statGpu).
    return (
        <Gtk.DrawingArea
            cssClasses={["statGraph", className]}
            valign={Gtk.Align.END}
            halign={Gtk.Align.END}
            hexpand={hexpand}
            $={self => {
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
                        const bh = Math.max(1, Math.round((samples[i].v / 100) * h))
                        cr.rectangle(i * bw, h - bh, Math.max(1, bw), bh)
                    }
                    cr.fill()
                })
                const unsub = hist.subscribe(redraw)
                onCleanup(unsub)
                redraw()
            }}
        />
    )
}

// resource utilization monitor on the panel: per-stat percentage plus a
// mini histogram (last 12 samples); quick settings has the detailed view
const BARS = 12
const short = (hist: Accessor<{ v: number }[]>) => hist.as(h => h.slice(-BARS))

export default function SysStats() {
    const tip = () => {
        const [rUsed, rTotal] = ramSize.get()
        const lines = [
            `CPU ${cpu.get()}%   load ${loadAvg.get().toFixed(2)}`,
            `RAM ${ram.get()}%   ${rUsed}/${rTotal} GB`,
        ]
        if (gpu.get() !== null) {
            const [vUsed, vTotal] = vram.get()
            lines.push(`GPU ${gpu.get()}% ${gpuTemp.get()}°C   ${vUsed}/${vTotal} MiB`)
        }
        lines.push(`↓ ${formatRate(netDown.get())}   ↑ ${formatRate(netUp.get())}`)
        return lines.join("\n")
    }

    return (
        <box cssClasses={["sysStats"]} spacing={8} tooltipText={ramSize.as(tip)}>
            <label cssClasses={["statCpu"]} label={cpu.as(v => `CPU ${v}%`)} />
            <Graph hist={short(cpuHist)} className="statCpu" height={12} hexpand={false} />
            <label cssClasses={["statRam"]} label={ram.as(v => `RAM ${v}%`)} />
            <Graph hist={short(ramHist)} className="statRam" height={12} hexpand={false} />
            <With value={gpu}>
                {g =>
                    g !== null && (
                        <box spacing={8}>
                            <label
                                cssClasses={["statGpu"]}
                                label={gpuTemp.as(t => `GPU ${g}% ${t}°C`)}
                            />
                            <Graph
                                hist={short(gpuHist)}
                                className="statGpu"
                                height={12}
                                hexpand={false}
                            />
                        </box>
                    )
                }
            </With>
            <label
                cssClasses={["statNet"]}
                label={createComputed(
                    [netDown, netUp],
                    (d, u) => `↓${formatRate(d)} ↑${formatRate(u)}`,
                )}
            />
        </box>
    )
}
