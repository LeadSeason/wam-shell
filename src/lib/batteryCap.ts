import AstalBattery from "gi://AstalBattery?version=0.1"
import Config from "../config"

// True when the battery sits at the charge limit AND the adapter is
// what holds it there. Percentage alone can't tell "on AC at the cap"
// from "unplugged at the cap" (or draining through a weak adapter): a
// genuinely DISCHARGING battery wins over the percentage check. The
// CHARGING flag is NOT used — UPower flickers it at the cap, which is
// why every caller used to judge by percentage alone (and claimed
// "on AC" for a discharging battery).
export function atChargeLimit(pct: number, state: AstalBattery.State): boolean {
    return (
        pct * 100 >= Config.quicksettings.batteryFullAt - 2 &&
        state !== AstalBattery.State.DISCHARGING
    )
}
