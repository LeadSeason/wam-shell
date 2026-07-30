import { Accessor, With, createComputed } from "gnim"
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
import { Graph } from "../../QSettings/StatsSection"

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
