# Prayer times

Local Muslim prayer times on the bar: a pill counting down to the next
prayer, with today's full timetable in its popover (next prayer
highlighted). Computed offline by the bundled
[adhan](https://github.com/batoulapps/adhan-js) library — no network, no
timetable service.

Section: `[prayer_times]`.

| Key                            | Type   | Default                 | What it does                                                                                                                                                                                                                                                      |
| ------------------------------ | ------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                      | bool   | `false`                 | Compute prayer times at all. While `false` the module never starts, never resolves a location, and the pill stays hidden — even when `prayertimes` sits in a `[[panel]]` list                                                                                     |
| `latitude`                     | number | `0`                     | Coordinates the times are computed for. Both `0` = detect once via GeoClue2 (see below); set BOTH to override                                                                                                                                                     |
| `longitude`                    | number | `0`                     | Same — the override only counts when both are non-zero                                                                                                                                                                                                            |
| `method`                       | string | `"jafari"`              | Calculation convention: `"jafari"`, `"tehran"`, or a Sunni method — `"mwl"`, `"egypt"`, `"karachi"`, `"makkah"`, `"qatar"`, `"kuwait"`, `"north_america"`, `"singapore"`                                                                                          |
| `madhab`                       | string | `"shafi"`               | Asr shadow rule: `"shafi"` (shadow = object length) or `"hanafi"` (twice). Ignored by `jafari`                                                                                                                                                                    |
| `high_latitude_rule`           | string | `"middle_of_the_night"` | How Fajr/Isha are estimated where the sun never reaches their twilight angles — `"middle_of_the_night"`, `"seventh_of_the_night"`, `"twilight_angle"`                                                                                                             |
| `visible_prayers`              | int    | `5`                     | Which prayers the popover lists (and the pill counts down to): `3` = Fajr, Dhuhr, Maghrib; `5` = all five prayers (Sunrise is a marker, not a prayer — never shown)                                                                                               |
| `pill_format`                  | string | `"time"`                | What the pill shows for the next prayer: `"time"` (`Fajr 05:27`), `"countdown"` (`Fajr in 6:16`), or `"both"`. The popover browses any day's times via the ‹ › arrows                                                                                             |
| `minimize_when_screen_sharing` | bool   | `true`                  | While screen sharing, shrink the pill to the bare time (`05:27`) — no prayer name, no countdown                                                                                                                                                                   |
| `notify`                       | bool   | `false`                 | Audible banner at each prayer time (the visible set only): CRITICAL-flagged — high priority, stays until dismissed — and suppressed under DND; the chime still plays. A shell (re)start never re-notifies a prayer already in                                     |
| `notify_sound`                 | string | `""`                    | Absolute path of the chime's sound file; empty = the freedesktop theme bell (played through the first of pw-play, paplay, canberra-gtk-play, ffplay)                                                                                                              |
| `offset_fajr` … `offset_isha`  | int    | `0`                     | Per-prayer shift in whole minutes, applied after calculation (−120…120) — for conventions that run a fixed number of minutes off the calculated time, e.g. `offset_fajr = 15`. Active offsets are listed in their own section at the bottom of the pill's popover |
| `on_panel`                     | bool   | `false`                 | Show the pill on the panel (legacy layout; with `[[panel]]` lists, add `"prayertimes"` to a list instead)                                                                                                                                                         |

## Method: jafari vs tehran

Both are Shia conventions and share Isha 14° and the Jafari midnight
rule; they differ in Fajr (16° vs 17.7°) and Maghrib (4° vs 4.5° past
sunset). `jafari` is the general Ithna Ashari convention; `tehran` is
the official Institute of Geophysics (University of Tehran) parameter
set used in Iran.

## Location

The easy path: `wam prayer-times setup` (optionally with a place name —
`wam prayer-times setup "Springfield, Illinois"`). It geocodes a city or
postal code once via OpenStreetMap's Nominatim service and writes
`latitude`/`longitude` (plus `enabled = true`) into your active config.
Nothing else is sent anywhere. The other keys can be set the same way —
`wam prayer-times set method tehran`,
`wam prayer-times set high_latitude_rule seventh_of_the_night` — with
values validated against the lists above.

With `latitude`/`longitude` left at `0` the shell instead asks GeoClue2
for a **one-shot, city-level** fix (no continuous tracking). GeoClue is
often disabled on desktop Linux or blocked waiting for an agent
authorization — if no coordinates can be resolved the module simply
stays inert and the pill hides (the log says so). Setting both keys is
the fix, and also the way to avoid location access entirely or to get
exact coordinates.

## High-latitude rule

Far north or south in summer the sun may never dip far enough for the
Fajr/Isha twilight angles to occur. The rule estimates those times from
the night length: `middle_of_the_night` splits the night at its middle,
`seventh_of_the_night` uses the earlier/later seventh (the common
recommendation above ~48.5°), `twilight_angle` scales the twilight
fraction of the night.

## Verify once

The times are astronomical calculations, not your local mosque's
timetable — conventions and rounding differ by a minute or two. Verify
once against your local authority; if a convention differs, `method` /
`madhab` are the switches, and the coordinate override is the correction
path for a bad location fix.
