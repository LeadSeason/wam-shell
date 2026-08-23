import { Accessor, For, createComputed, createState, onCleanup } from "gnim"
import Gtk from "gi://Gtk?version=4.0"
import Cairo from "gi://cairo"
import {
    cpu,
    cpuLevel,
    cpuPressure,
    ram,
    gpuHistFor,
    gpuIds,
    gpuLevelFor,
    gpuPanelTag,
    gpuPressures,
    gpus,
    formatPanelGpu,
    netDown,
    netUp,
    formatRate,
    cpuHist,
    ramHist,
    pressurePulse,
    ramLevel,
    ramSize,
    loadAvg,
} from "../../../lib/sysstats"
import type { PressureLevel } from "../../../lib/sysstats"
import CommandRegistry from "../../../lib/requestHandler"
import { pressable } from "../../pressable"

const registry = CommandRegistry.get_default()

// Tall enough that the difference between 20% and 60% is a difference
// you can see, short enough to sit INSIDE the row of readouts rather
// than under it. The old graph was bottom-aligned against a 36px bar,
// which parked it a whole text-height below the number it belonged to.
const GRAPH_HEIGHT = 14
// px of plot per sample, plus the margin the "now" dot needs to sit on
// the newest sample without painting half of itself past the edge
const SAMPLE_WIDTH = 2
const HEAD_MARGIN = 2

// Alpha the area fill carries at the top of the widget, fading to
// nothing at the floor. A flat wash reads as one grey block at 12px
// tall; the gradient is what lets a peak look like a peak.
const AREA_TOP = 0.45
const AREA_BOTTOM = 0.04
// the same fill on the pulse's ON beat — the throb is a brightness
// change, not an opacity animation, because a DrawingArea paints from
// its draw func and CSS animations don't run in this shell
const BEAT_TOP = 0.9

function Graph({
    hist,
    className,
    slots,
    level,
    height = GRAPH_HEIGHT,
    hexpand = true,
}: {
    hist: Accessor<{ v: number }[]>
    className: string
    /** samples the plot is sized for, filled from the right */
    slots: number
    /** recolors at warn, and also pulses at critical; omitted for the
     *  stats where being pegged is merely slow, never fatal */
    level?: Accessor<PressureLevel>
    height?: number
    hexpand?: boolean
}) {
    // A single DrawingArea replaces one <box> child per sample (up to 64
    // per stat), each tick rebuilding the lot. The colour comes from the
    // widget's CSS `color` (.statCpu/.statRam/.statGpu, overridden by
    // .warn/.critical), so the whole palette stays in the theme.
    return (
        <Gtk.DrawingArea
            cssClasses={
                level
                    ? level.as(l => ["statGraph", className, ...(l !== "" ? [l] : [])])
                    : ["statGraph", className]
            }
            valign={Gtk.Align.CENTER}
            halign={Gtk.Align.END}
            hexpand={hexpand}
            $={self => {
                self.set_content_height(height)
                // fixed, not sized to the samples in hand: a width that
                // grew as history filled shoved every widget to its
                // right sideways once a second for the first 16s of
                // every session
                self.set_content_width(slots * SAMPLE_WIDTH + HEAD_MARGIN)
                self.set_draw_func((_da: Gtk.DrawingArea, cr: any, w: number, h: number) => {
                    const samples = hist.get()
                    const n = samples.length
                    if (n === 0) return
                    const c = self.get_color()
                    const beat = level?.get() === "critical" && pressurePulse.get()

                    // the newest sample owns the right edge and history
                    // runs backwards from it, so a half-full buffer
                    // fills in from the right instead of stretching a
                    // handful of points across the whole plot
                    const right = w - HEAD_MARGIN
                    const step = slots > 1 ? right / (slots - 1) : 0
                    const x = (i: number) => right - (n - 1 - i) * step
                    // half a pixel of headroom at each end: a 1px stroke
                    // centred on the edge paints half of itself outside
                    const top = 1
                    const floor = h - 0.5
                    const y = (v: number) =>
                        floor - (Math.min(100, Math.max(0, v)) / 100) * (floor - top)

                    const trace = () => {
                        cr.moveTo(x(0), y(samples[0].v))
                        for (let i = 1; i < n; i++) cr.lineTo(x(i), y(samples[i].v))
                    }

                    // a floor hairline, so an idle stat still reads as a
                    // graph sitting at zero rather than as empty space
                    cr.setSourceRGBA(c.red, c.green, c.blue, c.alpha * 0.18)
                    cr.rectangle(0, h - 1, w, 1)
                    cr.fill()

                    const grad = new Cairo.LinearGradient(0, top, 0, h)
                    grad.addColorStopRGBA(
                        0,
                        c.red,
                        c.green,
                        c.blue,
                        c.alpha * (beat ? BEAT_TOP : AREA_TOP),
                    )
                    grad.addColorStopRGBA(1, c.red, c.green, c.blue, c.alpha * AREA_BOTTOM)
                    cr.setSource(grad)
                    trace()
                    cr.lineTo(x(n - 1), h)
                    cr.lineTo(x(0), h)
                    cr.closePath()
                    cr.fill()

                    cr.setSourceRGBA(c.red, c.green, c.blue, c.alpha)
                    cr.setLineWidth(beat ? 1.6 : 1)
                    cr.setLineJoin(Cairo.LineJoin.ROUND)
                    cr.setLineCap(Cairo.LineCap.ROUND)
                    trace()
                    cr.stroke()

                    // "now": the one point on a graph of history that is
                    // the number in the label beside it
                    cr.arc(x(n - 1), y(samples[n - 1].v), beat ? 2 : 1.4, 0, 2 * Math.PI)
                    cr.fill()
                })
                const redraw = () => self.queue_draw()
                // the level and the beat are read at DRAW time, so both
                // have to ask for a frame themselves — a css class flip
                // restyles the widget but does not repaint its content
                const unsubs = [hist.subscribe(redraw), pressurePulse.subscribe(redraw)]
                if (level) unsubs.push(level.subscribe(redraw))
                onCleanup(() => unsubs.forEach(u => u()))
                redraw()
            }}
        />
    )
}

// resource utilization monitor on the panel: per-stat percentage plus a
// mini sparkline (last 16 samples); quick settings has the detailed view
const BARS = 16
const short = (hist: Accessor<{ v: number }[]>) => hist.as(h => h.slice(-BARS))

// One stat: its readout and its own sparkline, in a box of their own.
// The panel's 8px rhythm alone left every graph equidistant from the
// label before it and the label after it, so each sparkline read as
// belonging to the NEXT stat — the tighter inner gap is what pairs them.
function Stat({
    name,
    label,
    hist,
    level,
}: {
    name: string
    label: Accessor<string>
    hist: Accessor<{ v: number }[]>
    level?: Accessor<PressureLevel>
}) {
    const classes = level ? level.as(l => [name, ...(l !== "" ? [l] : [])]) : [name]
    // The block behind the whole stat, flipped on the shared heartbeat.
    // It inverts readout AND sparkline together, so what flashes is one
    // object rather than two things blinking near each other.
    //
    // Imperative, NOT createComputed([level, pressurePulse], …). Both
    // deps start falsy ("" and false) and gnim's array-form dep cache
    // keys on falsy checks (AGENTS.md), which left this stuck on
    // ["statGroup"] forever when the level went critical LATE — the
    // only way it ever goes critical on a real machine. It survived
    // every demo because a threshold lowered before startup makes the
    // stat critical at mount, while the deps are still being read for
    // the first time.
    const [group, setGroup] = createState<string[]>(["statGroup"])
    if (level) {
        // tracked as a boolean so a beat that changes nothing does not
        // hand GTK a fresh array to diff twice a second
        let lit = false
        const sync = () => {
            const next = level.get() === "critical" && pressurePulse.get()
            if (next === lit) return
            lit = next
            setGroup(next ? ["statGroup", "statAlarm"] : ["statGroup"])
        }
        const unsubs = [level.subscribe(sync), pressurePulse.subscribe(sync)]
        onCleanup(() => unsubs.forEach(u => u()))
        sync()
    }
    return (
        <box cssClasses={group} spacing={4}>
            <label cssClasses={classes} label={label} />
            <Graph
                hist={short(hist)}
                className={name}
                slots={BARS}
                level={level}
                height={GRAPH_HEIGHT}
                hexpand={false}
            />
        </box>
    )
}

export default function SysStats() {
    // republished only when a card appears, vanishes or is renamed, so
    // the For does not tear the stats down and rebuild them once a
    // second the way the old <With value={gpu}> did
    const gpuTags = gpuIds.as(l =>
        l.map((g, i) => ({
            id: g.id,
            tag: gpuPanelTag(
                l.map(x => x.id),
                i,
            ),
        })),
    )

    const tip = () => {
        const [rUsed, rTotal] = ramSize.get()
        const lines = [
            `CPU ${cpu.get()}%   load ${loadAvg.get().toFixed(2)}`,
            `RAM ${ram.get()}%   ${rUsed}/${rTotal} GB`,
        ]
        const cards = gpus.get()
        const ids = cards.map(g => g.id)
        for (const [i, g] of cards.entries())
            lines.push(
                `${formatPanelGpu(gpuPanelTag(ids, i), g.busy, g.temp)}` +
                    `   ${g.vram[0]}/${g.vram[1]} MiB`,
            )
        lines.push(`↓ ${formatRate(netDown.get())}   ↑ ${formatRate(netUp.get())}`)
        // what the recolored sparkline is trying to say, spelled out —
        // a colour alone cannot say WHICH pool is nearly gone
        const alerts: string[] = []
        if (cpuLevel.get() !== "")
            // the number as well as the word. CPU is the one stat whose
            // trigger is not the percentage printed beside it — the
            // readout says the cores are busy, this says how long
            // something waited for one
            alerts.push(
                `${cpuLevel.get() === "critical" ? "Severe" : "High"} CPU contention` +
                    ` — stalled ${Math.round(cpuPressure.get() ?? 0)}% of the last minute`,
            )
        if (ramLevel.get() !== "")
            alerts.push(
                ramLevel.get() === "critical" ? "Severe memory pressure" : "High memory pressure",
            )
        // one alert per saturated card, NAMED once there is a second
        // card to confuse it with — the panel used to flash a single
        // block and then quote the other card's healthy figures at you
        for (const pg of gpuPressures.get())
            alerts.push(
                `${pg.level === "critical" ? "Severe" : "High"} GPU memory pressure` +
                    (ids.length > 1 ? ` — ${pg.name}` : ""),
            )
        if (alerts.length > 0) lines.push("", ...alerts.map(a => `⚠ ${a}`))
        lines.push("", "Click for Power Mode")
        return lines.join("\n")
    }

    return (
        <box
            cssClasses={["sysStats"]}
            spacing={8}
            // ramSize ticks with the poll, so the tooltip is rebuilt on
            // the same beat as everything it quotes; the levels are
            // folded in there rather than into a second binding
            tooltipText={ramSize.as(tip)}
        >
            {/* the sparklines say something is wrong; the pane says what
            to do about it. One click, straight there — the warnings, the
            per-card pages and the profile switch all live in it */}
            <Gtk.GestureClick
                button={1}
                {...pressable(() => {
                    registry.execute(["qsPane", "powerprofiles"], true)
                })}
            />
            <Stat name="statCpu" label={cpu.as(v => `CPU ${v}%`)} hist={cpuHist} level={cpuLevel} />
            <Stat name="statRam" label={ram.as(v => `RAM ${v}%`)} hist={ramHist} level={ramLevel} />
            {/* ONE STAT PER CARD. A single slot following the discrete
            card meant a saturated iGPU flashed its red block over the
            dGPU's healthy numbers, and the iGPU had no readout at all.
            The wrapper box holds the slot in place — the cards arrive a
            moment after the bar is built, and a child added late lands
            at the END of the parent (AGENTS.md), i.e. to the RIGHT of
            the network readout — and hides itself so the 8px gap does
            not open up on a machine with no GPU to report */}
            <box spacing={8} visible={gpuIds.as(l => l.length > 0)}>
                <For each={gpuTags}>
                    {({ id, tag }) => (
                        <Stat
                            name="statGpu"
                            label={gpus.as(l => {
                                const g = l.find(c => c.id === id)
                                return g ? formatPanelGpu(tag, g.busy, g.temp) : tag
                            })}
                            hist={gpuHistFor(id)}
                            level={gpuLevelFor(id)}
                        />
                    )}
                </For>
            </box>
            {/* no sparkline: the three above plot against a fixed
            0-100 axis, and a rate has no such ceiling — it would need
            an autoscale, and an autoscaled graph of an idle link draws
            the same shape as a saturated one. The rate reads fine as a
            number */}
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
