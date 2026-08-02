import GLib from "gi://GLib?version=2.0"
import { createState } from "gnim"
import { createPoll } from "ags/time"
import { readFile } from "ags/file"

// Power profile details for the power mode pane: the knobs a profile
// actually turns — CPU frequency vs its cap, governor, energy
// performance preference, package temperature, fan when exposed.
// Battery drain/time-left come from AstalBattery directly (UPower).
// Everything here is small sysfs reads on a 3s poll that runs ONLY
// while the pane is visible (setActive from the widget).

const read = (path: string): string => {
    try {
        return readFile(path).trim()
    } catch {
        return ""
    }
}

// per-core cpufreq dirs (cpu0..cpuN until one lacks scaling_cur_freq)
const cpuDirs: string[] = []
for (let i = 0; ; i++) {
    const dir = `/sys/devices/system/cpu/cpu${i}/cpufreq`
    if (!GLib.file_test(`${dir}/scaling_cur_freq`, GLib.FileTest.EXISTS)) break
    cpuDirs.push(dir)
}
const hasCpu = cpuDirs.length > 0
const capKhz = hasCpu ? Number(read(`${cpuDirs[0]}/cpuinfo_max_freq`)) : 0

// CPU package temperature: AMD k10temp / Intel coretemp via hwmon,
// first thermal zone as the fallback
function findTempPath(): string | null {
    try {
        const base = "/sys/class/hwmon"
        const d = GLib.Dir.open(base, 0)
        let name: string | null
        while ((name = d.read_name()) !== null) {
            const hwmon = `${base}/${name}`
            const hw = read(`${hwmon}/name`)
            if (
                (hw === "k10temp" || hw === "coretemp") &&
                GLib.file_test(`${hwmon}/temp1_input`, GLib.FileTest.EXISTS)
            ) {
                d.close()
                return `${hwmon}/temp1_input`
            }
        }
        d.close()
    } catch {}
    const zone0 = "/sys/class/thermal/thermal_zone0/temp"
    return GLib.file_test(zone0, GLib.FileTest.EXISTS) ? zone0 : null
}

// a laptop fan: vendor hwmon with fan1_input (GPU fans don't count)
function findFanPath(): string | null {
    try {
        const base = "/sys/class/hwmon"
        const d = GLib.Dir.open(base, 0)
        let name: string | null
        while ((name = d.read_name()) !== null) {
            const hwmon = `${base}/${name}`
            const hw = read(`${hwmon}/name`)
            if (
                /thinkpad|asus|dell|apple|hp|lenovo/i.test(hw) &&
                GLib.file_test(`${hwmon}/fan1_input`, GLib.FileTest.EXISTS)
            ) {
                d.close()
                return `${hwmon}/fan1_input`
            }
        }
        d.close()
    } catch {}
    return null
}

const tempPath = findTempPath()
const fanPath = findFanPath()

export const hasFreq = hasCpu
export const hasTemp = tempPath !== null
export const hasFan = fanPath !== null

const [freqAvgMhz, setFreqAvgMhz] = createState(0)
const [freqCapMhz] = createState(Math.round(capKhz / 1000))
const [governor, setGovernor] = createState("")
const [epp, setEpp] = createState("")
const [tempC, setTempC] = createState(0)
const [fanRpm, setFanRpm] = createState(0)
export { freqAvgMhz, freqCapMhz, governor, epp, tempC, fanRpm }

const poll = createPoll("", 3000, () => {
    try {
        if (hasCpu) {
            let sum = 0
            let n = 0
            for (const dir of cpuDirs) {
                const v = Number(read(`${dir}/scaling_cur_freq`))
                if (v > 0) {
                    sum += v
                    n++
                }
            }
            if (n > 0) setFreqAvgMhz(Math.round(sum / n / 1000))
            setGovernor(read(`${cpuDirs[0]}/scaling_governor`))
            setEpp(read(`${cpuDirs[0]}/energy_performance_preference`))
        }
        if (tempPath) setTempC(Math.round(Number(read(tempPath)) / 1000))
        if (fanPath) setFanRpm(Number(read(fanPath)) || 0)
    } catch (e) {
        console.warn("powerDetails:", e)
    }
    return ""
})

// createPoll is lazy until subscribed; run it only while the pane is
// visible (the widget drives this from the pane accessor)
let stopPoll: (() => void) | null = null
export function setActive(on: boolean) {
    if (on && !stopPoll) stopPoll = poll.subscribe(() => {})
    if (!on && stopPoll) {
        stopPoll()
        stopPoll = null
    }
}

// convention for lib modules with long-lived sources (see AGENTS.md)
export function dispose() {
    setActive(false)
}
