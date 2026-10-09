import { createComputed } from "gnim"
import { todayRx, todayTx, monthRx, monthTx, formatBytes } from "../../../lib/netTotals"

// cumulative bandwidth on the panel: today's download total, with the
// full today/month breakdown in the tooltip. The live rate stays in
// sysStats; this answers "how much have I used", not "how fast right now"
export default function NetStats() {
    const tip = () =>
        [
            `Today   ↓ ${formatBytes(todayRx.peek())}   ↑ ${formatBytes(todayTx.peek())}`,
            `Month   ↓ ${formatBytes(monthRx.peek())}   ↑ ${formatBytes(monthTx.peek())}`,
        ].join("\n")

    return (
        <box
            cssClasses={["netStats"]}
            tooltipText={createComputed(() => tip(todayRx(), todayTx(), monthRx(), monthTx()))}
        >
            <label
                cssClasses={["statNet"]}
                label={createComputed(() => {
                    const d = todayRx()
                    const u = todayTx()
                    return `↓${formatBytes(d)} ↑${formatBytes(u)}`
                })}
            />
        </box>
    )
}
