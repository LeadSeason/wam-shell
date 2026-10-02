import { test, eq } from "./framework"
import {
    buildCalcParams,
    todaysTimes,
    nextPrayer,
    currentPrayer,
    visibleSet,
    formatCountdown,
    formatPill,
    PrayerEntry,
} from "../src/lib/prayerTimes"

// Accuracy is load-bearing here: people plan prayers around these
// numbers. The reference values below are published timetables from the
// Aladhan API (api.aladhan.com/v1/timings, fetched at authoring time),
// NOT this library's own output — the test pins the math against an
// independent source. Tolerance is 150s: adhan rounds to the nearest
// minute while Aladhan truncates, and the Asr shadow convention differs
// by a rounding step — the worst observed gap was exactly 2 minutes.
const TOLERANCE_MS = 150_000

// 2026-03-15, Tehran (35.6892, 51.3890), Aladhan method 0 "Shia
// Ithna-Ashari" (Fajr 16°, Isha 14°, Maghrib 4°) — our "jafari"
const JAFARI_TEHRAN = {
    Fajr: "2026-03-15T05:01:00+03:30",
    Sunrise: "2026-03-15T06:16:00+03:30",
    Dhuhr: "2026-03-15T12:13:00+03:30",
    Asr: "2026-03-15T15:36:00+03:30",
    Maghrib: "2026-03-15T18:27:00+03:30",
    Isha: "2026-03-15T19:17:00+03:30",
}

// 2026-03-15, Mecca (21.4225, 39.8262), Aladhan method 3 "Muslim World
// League", standard (shafi) Asr
const MWL_MECCA = {
    Fajr: "2026-03-15T05:16:00+03:00",
    Sunrise: "2026-03-15T06:30:00+03:00",
    Dhuhr: "2026-03-15T12:30:00+03:00",
    Asr: "2026-03-15T15:53:00+03:00",
    Maghrib: "2026-03-15T18:30:00+03:00",
    Isha: "2026-03-15T19:40:00+03:00",
}

function checkAgainstReference(
    label: string,
    times: PrayerEntry[],
    reference: Record<string, string>,
) {
    eq(times.length, 6, `${label}: expected six times`)
    for (const { name, time } of times) {
        const expected = new Date(reference[name]).getTime()
        const drift = Math.abs(time.getTime() - expected)
        if (drift > TOLERANCE_MS)
            throw new Error(
                `${label}: ${name} off by ${Math.round(drift / 1000)}s ` +
                    `(got ${time.toISOString()}, reference ${reference[name]})`,
            )
    }
}

// noon on the reference day: adhan computes the day its Date falls in,
// and noon is safely inside it in every timezone the CI machine might run
const REF_DAY = new Date(2026, 2, 15, 12, 0, 0)

test("todaysTimes: jafari matches the published Ithna-Ashari timetable (Tehran)", () => {
    const params = buildCalcParams("jafari", "shafi", "middle_of_the_night")
    const times = todaysTimes(params, { latitude: 35.6892, longitude: 51.389 }, REF_DAY)
    checkAgainstReference("jafari/tehran", times, JAFARI_TEHRAN)
})

test("todaysTimes: mwl matches the published Muslim World League timetable (Mecca)", () => {
    const params = buildCalcParams("mwl", "shafi", "middle_of_the_night")
    const times = todaysTimes(params, { latitude: 21.4225, longitude: 39.8262 }, REF_DAY)
    checkAgainstReference("mwl/mecca", times, MWL_MECCA)
})

// Edinburgh (55.95°N) at the summer solstice: the sun never dips to the
// MWL Fajr/Isha angles, so each high-latitude rule must step in and
// still produce finite, ordered times
test("todaysTimes: every high_latitude_rule yields finite ordered times at high latitude", () => {
    for (const rule of ["middle_of_the_night", "seventh_of_the_night", "twilight_angle"]) {
        const params = buildCalcParams("mwl", "shafi", rule)
        const times = todaysTimes(
            params,
            { latitude: 55.9533, longitude: -3.1883 },
            new Date(2026, 5, 21, 12, 0, 0),
        )
        for (const { name, time } of times)
            if (!Number.isFinite(time.getTime()))
                throw new Error(`${rule}: ${name} is not a finite time`)
        for (let i = 1; i < times.length; i++)
            if (times[i].time.getTime() <= times[i - 1].time.getTime())
                throw new Error(
                    `${rule}: ${times[i].name} (${times[i].time.toISOString()}) ` +
                        `is not after ${times[i - 1].name}`,
                )
    }
})

test("buildCalcParams: jafari is the custom 16°/14°/4° Ithna-Ashari set, always shafi", () => {
    for (const madhab of ["shafi", "hanafi"]) {
        const p = buildCalcParams("jafari", madhab, "middle_of_the_night")
        eq(p.fajrAngle, 16)
        eq(p.ishaAngle, 14)
        eq(p.maghribAngle, 4)
        eq(p.madhab, "shafi", `jafari must ignore madhab=${madhab}`)
    }
})

test("buildCalcParams: every config method string maps to its published angles", () => {
    const cases: [string, number, number, number][] = [
        // method, fajrAngle, ishaAngle, maghribAngle (0 = ishaInterval
        // methods and sunset-maghrib methods both leave it 0)
        ["tehran", 17.7, 14, 4.5],
        ["mwl", 18, 17, 0],
        ["egypt", 19.5, 17.5, 0],
        ["karachi", 18, 18, 0],
        ["makkah", 18.5, 0, 0],
        ["qatar", 18, 0, 0],
        ["kuwait", 18, 17.5, 0],
        ["north_america", 15, 15, 0],
        ["singapore", 20, 18, 0],
    ]
    for (const [method, fajr, isha, maghrib] of cases) {
        const p = buildCalcParams(method, "shafi", "middle_of_the_night")
        eq(p.fajrAngle, fajr, `${method}.fajrAngle`)
        eq(p.ishaAngle, isha, `${method}.ishaAngle`)
        eq(p.maghribAngle, maghrib, `${method}.maghribAngle`)
    }
})

test("buildCalcParams: makkah/qatar use isha intervals, madhab and HLR map through", () => {
    eq(buildCalcParams("makkah", "shafi", "middle_of_the_night").ishaInterval, 90)
    eq(buildCalcParams("qatar", "shafi", "middle_of_the_night").ishaInterval, 90)
    eq(buildCalcParams("mwl", "hanafi", "middle_of_the_night").madhab, "hanafi")
    eq(buildCalcParams("mwl", "shafi", "middle_of_the_night").highLatitudeRule, "middleofthenight")
    eq(
        buildCalcParams("mwl", "shafi", "seventh_of_the_night").highLatitudeRule,
        "seventhofthenight",
    )
    eq(buildCalcParams("mwl", "shafi", "twilight_angle").highLatitudeRule, "twilightangle")
})

test("buildCalcParams: an unknown method falls back to jafari", () => {
    const p = buildCalcParams("nonsense", "shafi", "middle_of_the_night")
    eq(p.fajrAngle, 16)
    eq(p.maghribAngle, 4)
})

test("buildCalcParams: offsets land in adjustments, unset prayers stay 0", () => {
    const p = buildCalcParams("jafari", "shafi", "middle_of_the_night", {
        fajr: 15,
        maghrib: -5,
    })
    eq(p.adjustments.fajr, 15)
    eq(p.adjustments.maghrib, -5)
    eq(p.adjustments.dhuhr, 0)
    eq(p.adjustments.asr, 0)
    eq(p.adjustments.isha, 0)
})

test("todaysTimes: an offset shifts exactly its own prayer by its minutes", () => {
    const plain = todaysTimes(
        buildCalcParams("jafari", "shafi", "middle_of_the_night"),
        { latitude: 35.6892, longitude: 51.389 },
        REF_DAY,
    )
    const shifted = todaysTimes(
        buildCalcParams("jafari", "shafi", "middle_of_the_night", { fajr: 15 }),
        { latitude: 35.6892, longitude: 51.389 },
        REF_DAY,
    )
    for (let i = 0; i < plain.length; i++) {
        const expected = plain[i].time.getTime() + (plain[i].name === "Fajr" ? 15 : 0) * 60_000
        // adhan rounds to the minute both ways, so the shift is exact to ±1s
        if (Math.abs(shifted[i].time.getTime() - expected) > 1000)
            throw new Error(
                `${plain[i].name}: shift was ${(shifted[i].time.getTime() - plain[i].time.getTime()) / 60000} min`,
            )
    }
})

const DAY = [
    ["Fajr", "2026-03-15T05:00:00Z"],
    ["Sunrise", "2026-03-15T06:20:00Z"],
    ["Dhuhr", "2026-03-15T12:10:00Z"],
    ["Asr", "2026-03-15T15:30:00Z"],
    ["Maghrib", "2026-03-15T18:25:00Z"],
    ["Isha", "2026-03-15T19:40:00Z"],
].map(([name, iso]) => ({ name: name as string, time: new Date(iso as string) }))

test("nextPrayer: before Fajr, mid-day, and after Isha", () => {
    eq(nextPrayer(DAY, new Date("2026-03-15T03:00:00Z").getTime())?.name, "Fajr")
    eq(nextPrayer(DAY, new Date("2026-03-15T13:00:00Z").getTime())?.name, "Asr")
    // exactly at a prayer's minute, that prayer is already now, not next
    eq(nextPrayer(DAY, new Date("2026-03-15T12:10:00Z").getTime())?.name, "Asr")
    eq(nextPrayer(DAY, new Date("2026-03-15T20:00:00Z").getTime()), null)
})

test("nextPrayer: after Isha rolls to tomorrow's Fajr when given", () => {
    const fajr = new Date("2026-03-16T04:59:00Z")
    const next = nextPrayer(DAY, new Date("2026-03-15T20:00:00Z").getTime(), fajr)
    eq(next?.name, "Fajr")
    eq(next?.time.getTime(), fajr.getTime())
})

test("visibleSet: 3 is Fajr, Dhuhr, Maghrib; 5 is all five prayers (no Sunrise)", () => {
    eq(
        visibleSet(DAY, 3)
            .map(e => e.name)
            .join(","),
        "Fajr,Dhuhr,Maghrib",
    )
    eq(
        visibleSet(DAY, 5)
            .map(e => e.name)
            .join(","),
        "Fajr,Dhuhr,Asr,Maghrib,Isha",
    )
    // entries keep their times, in chronological order
    eq(visibleSet(DAY, 3)[1].time.getTime(), DAY[2].time.getTime())
    // an unknown value degrades to the full set
    eq(visibleSet(DAY, 99).length, 5)
})

test("nextPrayer over the reduced set: the pill skips hidden prayers", () => {
    const three = visibleSet(DAY, 3)
    // 13:00Z is before Asr — but Asr is not in the 3-set, so Maghrib is next
    eq(nextPrayer(three, new Date("2026-03-15T13:00:00Z").getTime())?.name, "Maghrib")
    // after Maghrib the day is done: null without a rollover, Fajr with one
    const fajr = new Date("2026-03-16T04:59:00Z")
    eq(nextPrayer(three, new Date("2026-03-15T19:00:00Z").getTime()), null)
    eq(nextPrayer(three, new Date("2026-03-15T19:00:00Z").getTime(), fajr)?.name, "Fajr")
})

test("currentPrayer: the most recent arrival, null before the first", () => {
    eq(currentPrayer(DAY, new Date("2026-03-15T03:00:00Z").getTime()), null)
    eq(currentPrayer(DAY, new Date("2026-03-15T05:00:00Z").getTime())?.name, "Fajr")
    eq(currentPrayer(DAY, new Date("2026-03-15T13:00:00Z").getTime())?.name, "Dhuhr")
    eq(currentPrayer(DAY, new Date("2026-03-15T23:00:00Z").getTime())?.name, "Isha")
    // hidden prayers never fire: in the 3-set, 21:00's current is Maghrib
    eq(
        currentPrayer(visibleSet(DAY, 3), new Date("2026-03-15T21:00:00Z").getTime())?.name,
        "Maghrib",
    )
})

test("formatCountdown: boundaries", () => {
    eq(formatCountdown(-5000), "0:00")
    eq(formatCountdown(0), "0:00")
    eq(formatCountdown(59_999), "0:00")
    eq(formatCountdown(60_000), "0:01")
    eq(formatCountdown(3_599_000), "0:59")
    eq(formatCountdown(3_600_000), "1:00")
    eq(formatCountdown(5_340_000), "1:29")
    eq(formatCountdown(36_000_000), "10:00")
})

test("formatPill: time, countdown, both, and empty", () => {
    // local-time components, so the label is 05:27 in any test-machine tz
    const nowMs = new Date(2026, 2, 16, 4, 0, 0).getTime()
    const next = { name: "Fajr", time: new Date(2026, 2, 16, 5, 27, 0) }
    eq(formatPill("time", next, nowMs), "Fajr 05:27")
    eq(formatPill("countdown", next, nowMs), "Fajr in 1:27")
    eq(formatPill("both", next, nowMs), "Fajr 05:27 · in 1:27")
    eq(formatPill("whatever", next, nowMs), "Fajr 05:27") // unknown → time
    eq(formatPill("time", null, nowMs), "")
})

test("formatPill: minimal (screen sharing) is the bare time, whatever the format", () => {
    const nowMs = new Date(2026, 2, 16, 4, 0, 0).getTime()
    const next = { name: "Fajr", time: new Date(2026, 2, 16, 5, 27, 0) }
    for (const format of ["time", "countdown", "both"])
        eq(formatPill(format, next, nowMs, true), "05:27", `format=${format}`)
    eq(formatPill("time", null, nowMs, true), "")
})
