import { createState } from "gnim"
import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import AstalNotifd from "gi://AstalNotifd?version=0.1"
import {
    Coordinates,
    CalculationMethod,
    CalculationParameters,
    HighLatitudeRule,
    Madhab,
    PrayerTimes,
} from "adhan"
import Config from "../config"
import { timeoutAddSeconds, sourceRemove } from "./metrics"
import { registerDispose } from "./lifecycle"
import { sharing, enable as enableShareWatch } from "./captureWatch"
import { addProviderPopup, dnd } from "./notifd"

// Local prayer times, computed offline by the bundled `adhan` library —
// no network, no timetable service. The module is inert unless
// [prayer_times] enabled = true: only then does it resolve coordinates,
// either from the config's latitude/longitude override or a ONE-SHOT
// GeoClue2 city-level read (never continuous tracking). With neither
// available it stays inert and the bar pill hides.
//
// The times are astronomical calculations, not a mosque's timetable —
// the wiki page tells the user to verify once against their local
// authority. The math itself is pinned by tests/prayerTimes.test.ts
// against published reference timetables.

const LOG_TAG = "prayertimes"
const TICK_SECONDS = 30
const GEO_TIMEOUT_SECONDS = 10

const NAMES = ["Fajr", "Sunrise", "Dhuhr", "Asr", "Maghrib", "Isha"] as const
const KEYS = ["fajr", "sunrise", "dhuhr", "asr", "maghrib", "isha"] as const

export interface PrayerEntry {
    name: string
    time: Date
}

/** a timetable row as the bar popover renders it */
export interface PrayerRow {
    name: string
    label: string // "HH:MM"
    next: boolean
}

export interface LatLon {
    latitude: number
    longitude: number
}

/** per-prayer minute shifts, applied after calculation (adhan `adjustments`) */
export interface PrayerOffsets {
    fajr?: number
    dhuhr?: number
    asr?: number
    maghrib?: number
    isha?: number
}

/**
 * Map the config strings to adhan's parameters. "jafari" (Ithna Ashari:
 * Fajr 16°, Isha 14°, Maghrib 4° past sunset — an angle, not sunset
 * itself) has no builtin and is spelled out; everything else maps to a
 * library builtin. `madhab` sets the Asr shadow length (jafari is
 * always shafi); the high-latitude rule decides how Fajr/Isha are
 * estimated where the sun never dips to their angles. `offsets` are
 * plain minute shifts per prayer, for conventions that run a fixed
 * number of minutes off the calculated time.
 */
export function buildCalcParams(
    method: string,
    madhab: string,
    highLatitudeRule: string,
    offsets: PrayerOffsets = {},
): CalculationParameters {
    let params: CalculationParameters
    switch (method) {
        case "tehran":
            params = CalculationMethod.Tehran()
            break
        case "mwl":
            params = CalculationMethod.MuslimWorldLeague()
            break
        case "egypt":
            params = CalculationMethod.Egyptian()
            break
        case "karachi":
            params = CalculationMethod.Karachi()
            break
        case "makkah":
            params = CalculationMethod.UmmAlQura()
            break
        case "qatar":
            params = CalculationMethod.Qatar()
            break
        case "kuwait":
            params = CalculationMethod.Kuwait()
            break
        case "north_america":
            params = CalculationMethod.NorthAmerica()
            break
        case "singapore":
            params = CalculationMethod.Singapore()
            break
        case "jafari":
        default:
            params = new CalculationParameters("Other", 16, 14)
            params.maghribAngle = 4
            break
    }
    params.madhab = method === "jafari" || madhab !== "hanafi" ? Madhab.Shafi : Madhab.Hanafi
    params.highLatitudeRule =
        highLatitudeRule === "seventh_of_the_night"
            ? HighLatitudeRule.SeventhOfTheNight
            : highLatitudeRule === "twilight_angle"
              ? HighLatitudeRule.TwilightAngle
              : HighLatitudeRule.MiddleOfTheNight
    if (offsets.fajr) params.adjustments.fajr = offsets.fajr
    if (offsets.dhuhr) params.adjustments.dhuhr = offsets.dhuhr
    if (offsets.asr) params.adjustments.asr = offsets.asr
    if (offsets.maghrib) params.adjustments.maghrib = offsets.maghrib
    if (offsets.isha) params.adjustments.isha = offsets.isha
    return params
}

export function todaysTimes(
    params: CalculationParameters,
    coords: LatLon,
    date: Date,
): PrayerEntry[] {
    const pt = new PrayerTimes(new Coordinates(coords.latitude, coords.longitude), date, params)
    return KEYS.map((k, i) => ({ name: NAMES[i], time: pt[k] }))
}

/**
 * The first entry still ahead of `nowMs` (Sunrise counts — it is a time
 * people plan around, like adhan's own nextPrayer). After Isha, returns
 * tomorrow's Fajr when the caller passes it, else null.
 */
export function nextPrayer(
    times: PrayerEntry[],
    nowMs: number,
    tomorrowFajr?: Date,
): PrayerEntry | null {
    for (const t of times) if (t.time.getTime() > nowMs) return t
    return tomorrowFajr ? { name: NAMES[0], time: tomorrowFajr } : null
}

/** remaining time as h:mm, floored to the minute and clamped at 0:00 */
export function formatCountdown(ms: number): string {
    const totalMin = Math.max(0, Math.floor(ms / 60000))
    return `${Math.floor(totalMin / 60)}:${String(totalMin % 60).padStart(2, "0")}`
}

// the two fixed sets behind [prayer_times] visible_prayers, as indices
// into the timetable: 3 = Fajr, Dhuhr, Maghrib; 5 = all five prayers
// (Sunrise is a marker, not a prayer — never in a set)
const VISIBLE_SETS: Record<number, number[]> = {
    3: [0, 2, 4],
    5: [0, 2, 3, 4, 5],
}

/**
 * The timetable reduced to the configured set. The same set feeds the
 * popover rows and the pill's next-prayer rotation — a pill counting
 * down to a prayer the popover hides would read as a bug.
 */
export function visibleSet(times: PrayerEntry[], visiblePrayers: number): PrayerEntry[] {
    const set = VISIBLE_SETS[visiblePrayers] ?? VISIBLE_SETS[5]
    return set.map(i => times[i])
}

/**
 * The prayer whose time has most recently arrived (null before the
 * day's first one). Its transitions drive the notification fires.
 */
export function currentPrayer(rows: PrayerEntry[], nowMs: number): PrayerEntry | null {
    let current: PrayerEntry | null = null
    for (const e of rows) if (e.time.getTime() <= nowMs) current = e
    return current
}

export const [coordsReady, setCoordsReady] = createState(false)
export const [timetable, setTimetable] = createState<PrayerRow[]>([])
export const [pillLabel, setPillLabel] = createState("")
/** active offsets, listed in the popover's bottom section ("Fajr +15 min") — empty when none */
export const [offsetNotes, setOffsetNotes] = createState<string[]>([])

type GeoclueMod = typeof import("gi://Geoclue?version=2.0").default

let params: CalculationParameters | null = null
let coords: LatLon | null = null
let todayEntries: PrayerEntry[] = []
let computedDay = ""
let tickSource = 0
let geoTimeout = 0
let geoClient: { call_stop(cancellable: null, callback: null): void } | null = null
let sharingUnsub: (() => void) | null = null
let offsetByName: Record<string, number> = {}
let notifiedKey = ""
let notifyPrimed = false
let disposed = false

const dayKey = () => GLib.DateTime.new_now_local().format("%Y-%m-%d") ?? ""

const timeLabel = (t: Date) =>
    GLib.DateTime.new_from_unix_local(Math.floor(t.getTime() / 1000)).format("%H:%M") ?? ""

/**
 * The pill's text for the configured format: the next prayer's clock
 * time ("Fajr 05:27"), the countdown ("Fajr in 6:16"), or both.
 * `minimal` (screen sharing) strips it to the bare time ("05:27").
 * Offsets are NOT marked here — they sit in the popover's own section.
 */
export function formatPill(
    format: string,
    next: PrayerEntry | null,
    nowMs: number,
    minimal = false,
): string {
    if (!next) return ""
    if (minimal) return timeLabel(next.time)
    const countdown = `in ${formatCountdown(next.time.getTime() - nowMs)}`
    if (format === "countdown") return `${next.name} ${countdown}`
    if (format === "both") return `${next.name} ${timeLabel(next.time)} · ${countdown}`
    return `${next.name} ${timeLabel(next.time)}`
}

/**
 * The popover's day browser: the configured prayer set for ANY date, as
 * render-ready rows (next: false — the highlight only exists today).
 * Empty while the module is inert.
 */
export function rowsForDate(date: Date): PrayerRow[] {
    if (!params || !coords) return []
    return visibleSet(todaysTimes(params, coords, date), Config.prayerTimes.visiblePrayers).map(
        e => ({ name: e.name, label: timeLabel(e.time), next: false }),
    )
}

function stopGeoClient() {
    if (!geoClient) return
    try {
        geoClient.call_stop(null, null)
    } catch (e) {
        console.warn(`${LOG_TAG}: failed stopping geoclue client:`, e)
    }
    geoClient = null
}

/**
 * Config latitude/longitude (both non-zero) win outright — GeoClue is
 * never touched. Otherwise one city-level GeoClue2 read: Simple.new
 * starts a client, we take the first location it reports and stop the
 * client again. A timeout caps the wait: a GeoClue agent waiting on
 * authorization must not hang the module.
 */
async function resolveCoords(): Promise<LatLon | null> {
    const conf = Config.prayerTimes
    if (conf.latitude !== 0 && conf.longitude !== 0)
        return { latitude: conf.latitude, longitude: conf.longitude }
    try {
        const mod: GeoclueMod = (await import("gi://Geoclue?version=2.0")).default
        const simple = await Promise.race([
            new Promise<InstanceType<GeoclueMod["Simple"]>>((resolve, reject) => {
                mod.Simple.new("wam-shell", mod.AccuracyLevel.CITY, null, (_s, res) => {
                    try {
                        resolve(mod.Simple.new_finish(res))
                    } catch (e) {
                        reject(e)
                    }
                })
            }),
            new Promise<null>(resolve => {
                geoTimeout = timeoutAddSeconds(
                    "prayertimes:geotimeout",
                    GLib.PRIORITY_DEFAULT,
                    GEO_TIMEOUT_SECONDS,
                    () => {
                        geoTimeout = 0
                        resolve(null)
                        return GLib.SOURCE_REMOVE
                    },
                )
            }),
        ])
        if (geoTimeout) {
            sourceRemove(geoTimeout)
            geoTimeout = 0
        }
        const loc = simple?.location
        if (!loc) {
            // the common case: geoclue answered nothing within the
            // timeout — typically no agent running to authorize the
            // request (bare compositor sessions have none)
            console.warn(
                `${LOG_TAG}: no location from geoclue within ${GEO_TIMEOUT_SECONDS}s; ` +
                    `set latitude/longitude in [prayer_times]`,
            )
            return null
        }
        return { latitude: loc.latitude, longitude: loc.longitude }
    } catch (e) {
        console.warn(
            `${LOG_TAG}: no coordinates from geoclue; set latitude/longitude in [prayer_times]:`,
            e,
        )
        return null
    } finally {
        stopGeoClient()
    }
}

// ------------------------------------------------- prayer-time notify

// one-shot chime through the first player that exists (sleepTimer's
// chain, minus the loop): a missing player or sound just means silent
const SOUND_CANDIDATES = [
    "/usr/share/sounds/freedesktop/stereo/bell.oga",
    "/usr/share/sounds/freedesktop/stereo/complete.oga",
    "/usr/share/sounds/freedesktop/stereo/alarm-clock-elapsed.oga",
]
const PLAYER_CANDIDATES: string[][] = [
    ["pw-play"],
    ["paplay"],
    ["canberra-gtk-play", "-f"],
    ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet"],
]
let chimeProc: Gio.Subprocess | null = null

function playChime() {
    const conf = Config.prayerTimes.notifySound
    const file =
        conf && GLib.file_test(conf, GLib.FileTest.EXISTS)
            ? conf
            : (SOUND_CANDIDATES.find(p => GLib.file_test(p, GLib.FileTest.EXISTS)) ?? null)
    const player = PLAYER_CANDIDATES.find(argv => GLib.find_program_in_path(argv[0]) !== null)
    if (!file || !player) return
    try {
        chimeProc = Gio.Subprocess.new(
            [...player, file],
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
        )
        chimeProc.wait_check_async(null, (_p, res) => {
            try {
                chimeProc?.wait_check_finish(res)
            } catch (e) {
                console.warn(`${LOG_TAG}: chime player failed:`, e)
            }
            chimeProc = null
        })
    } catch (e) {
        console.warn(`${LOG_TAG}: failed to play chime:`, e)
    }
}

// high-priority banner, the shell's own terms: CRITICAL with no expiry
// — it never drains, it stays until dismissed. DND still suppresses it,
// because the check is OURS: addPopup's own gate would let a critical
// break through. The chime plays regardless: the prayer time itself
// doesn't wait for a mood
function fireNotify(entry: PrayerEntry) {
    if (!dnd.get())
        addProviderPopup(
            {
                id: `prayer:${entry.name}-${dayKey()}`,
                provider: "prayer",
                time: Date.now() / 1000,
                appName: "Prayer times",
                summary: entry.name,
                body: timeLabel(entry.time),
                iconName: "alarm-symbolic",
                url: "",
                hide: () => {},
                dismiss: () => {},
                activate: () => {},
            },
            AstalNotifd.Urgency.CRITICAL,
        )
    playChime()
}

function publish() {
    if (!params || !coords) return
    const now = Date.now()
    const key = dayKey()
    if (computedDay !== key) {
        todayEntries = todaysTimes(params, coords, new Date())
        computedDay = key
    }
    const rows = visibleSet(todayEntries, Config.prayerTimes.visiblePrayers)
    if (Config.prayerTimes.notify) {
        // fire on ARRIVAL transitions only: the boot publish primes the
        // key, so a restart never re-notifies a prayer already in
        const cur = currentPrayer(rows, now)
        const curKey = cur ? `${cur.name}|${cur.time.getTime()}` : ""
        if (!notifyPrimed) {
            notifyPrimed = true
            notifiedKey = curKey
        } else if (curKey && curKey !== notifiedKey) {
            notifiedKey = curKey
            fireNotify(cur!)
        }
    }
    // after the day's last shown prayer the pill counts down to
    // tomorrow's first one (Fajr in both sets) and no row is
    // highlighted — that is the intent
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const tomorrowFirst = visibleSet(
        todaysTimes(params, coords, tomorrow),
        Config.prayerTimes.visiblePrayers,
    )[0]
    const next = nextPrayer(rows, now, tomorrowFirst.time)
    const mapped = rows.map(e => ({
        name: e.name,
        label: timeLabel(e.time),
        next: next !== null && e.time.getTime() === next.time.getTime(),
    }))
    // the tick fires every 30s but the rows change a handful of times a
    // day — re-emitting an identical array makes every subscriber
    // rebuild (the popover's For destroys and recreates its rows,
    // visible as a flash), so only publish real changes
    const prev = timetable.get()
    if (
        mapped.length !== prev.length ||
        mapped.some(
            (r, i) =>
                r.name !== prev[i].name || r.label !== prev[i].label || r.next !== prev[i].next,
        )
    )
        setTimetable(mapped)
    setPillLabel(
        formatPill(
            Config.prayerTimes.pillFormat,
            next,
            now,
            Config.prayerTimes.minimizeWhenScreenSharing && sharing.get(),
        ),
    )
}

async function start() {
    const conf = Config.prayerTimes
    params = buildCalcParams(conf.method, conf.madhab, conf.highLatitudeRule, {
        fajr: conf.offsetFajr,
        dhuhr: conf.offsetDhuhr,
        asr: conf.offsetAsr,
        maghrib: conf.offsetMaghrib,
        isha: conf.offsetIsha,
    })
    offsetByName = {
        Fajr: conf.offsetFajr,
        Dhuhr: conf.offsetDhuhr,
        Asr: conf.offsetAsr,
        Maghrib: conf.offsetMaghrib,
        Isha: conf.offsetIsha,
    }
    setOffsetNotes(
        NAMES.filter(n => offsetByName[n]).map(
            n => `${n} ${offsetByName[n] > 0 ? "+" : ""}${offsetByName[n]} min`,
        ),
    )
    coords = await resolveCoords()
    if (disposed || !coords) return // inert: the pill stays hidden
    setCoordsReady(true)
    if (conf.minimizeWhenScreenSharing) {
        enableShareWatch()
        sharingUnsub = sharing.subscribe(() => publish())
    }
    publish()
    tickSource = timeoutAddSeconds("prayertimes:tick", GLib.PRIORITY_DEFAULT, TICK_SECONDS, () => {
        publish()
        return GLib.SOURCE_CONTINUE
    })
}

// convention for lib modules with long-lived sources (see AGENTS.md)
export function dispose() {
    disposed = true
    if (tickSource) {
        sourceRemove(tickSource)
        tickSource = 0
    }
    if (geoTimeout) {
        sourceRemove(geoTimeout)
        geoTimeout = 0
    }
    sharingUnsub?.()
    sharingUnsub = null
    chimeProc?.force_exit()
    chimeProc = null
    stopGeoClient()
}

// disabled means no coordinates, no timers, no geoclue: the states
// stay at their inert defaults and the pill never shows
if (Config.prayerTimes.enabled) void start()

registerDispose("prayerTimes", dispose)
