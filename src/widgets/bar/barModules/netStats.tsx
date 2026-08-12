import { createComputed } from "gnim"
import { todayRx, todayTx, monthRx, monthTx, formatBytes } from "../../../lib/netTotals"

// cumulative bandwidth on the panel: today's download total, with the
// full today/month breakdown in the tooltip. The live rate stays in
// sysStats; this answers "how much have I used", not "how fast right now"
export default function NetStats() {
    const tip = () =>
        [
            `Today   ↓ ${formatBytes(todayRx.get())}   ↑ ${formatBytes(todayTx.get())}`,
            `Month   ↓ ${formatBytes(monthRx.get())}   ↑ ${formatBytes(monthTx.get())}`,
        ].join("\n")

    return (
        <box
            cssClasses={["netStats"]}
            tooltipText={createComputed([todayRx, todayTx, monthRx, monthTx], tip)}
        >
            <label
                cssClasses={["statNet"]}
                label={createComputed(
                    [todayRx, todayTx],
                    (d, u) => `↓${formatBytes(d)} ↑${formatBytes(u)}`,
                )}
            />
        </box>
    )
}
