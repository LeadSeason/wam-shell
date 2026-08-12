import GLib from "gi://GLib?version=2.0"
import Gio from "gi://Gio?version=2.0"
import AstalNetwork from "gi://AstalNetwork?version=0.1"
import { readFile } from "ags/file"
import Config from "../../config"
import { timeoutAdd, timeoutAddSeconds, sourceRemove, connect, disconnect } from "../metrics"
import { active, request, fetchAll } from "./api"
import { Entry, Project, mapEntry, localDay, dayTimeline } from "./timeline"
import { accountMode } from "./account"
import { armNotifications } from "./notify"
import {
    running,
    authDisabled,
    setAuthDisabled,
    setProjects,
    setRecents,
    setDayEntries,
    todayMap,
    adoptRunning,
    refreshStoppedFromMap,
} from "./state"

// the sync engine: fast delta poll, ±1d window, baseline probe, slow
// fetch, midnight rollover, lock/connectivity gating, auth kill-switch.
// Writes land in state.ts; user mutations live in actions.ts

/** send a notification through the daemon (same pattern as bluetooth) */
function notify(summary: string, body: string) {
    Gio.DBus.session.call(
        "org.freedesktop.Notifications",
        "/org/freedesktop/Notifications",
        "org.freedesktop.Notifications",
        "Notify",
        new GLib.Variant("(susssasa{sv}i)", [
            "wam-shell",
            0,
            "dialog-warning-symbolic",
            summary,
            body,
            [],
            { urgency: new GLib.Variant("y", 2) },
            -1,
        ]),
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (_conn, res) => {
            try {
                Gio.DBus.session.call_finish(res)
            } catch (e) {
                console.warn("harvest notify failed:", e)
            }
        },
    )
}

// ------------------------------------------------- past-day browser

// rapid navigation fires one fetch per change with no natural
// ordering: only the latest request may write (same trick as the
// window fetch's requestSeq)
let dayFetchSeq = 0

// 0 = today, -1 = yesterday, …: fetch that day into dayEntries
export function fetchDayOffset(offsetDays: number) {
    if (!active || offsetDays === 0) return
    const seq = ++dayFetchSeq
    const day = localDay(offsetDays)
    fetchAll(`/time_entries?from=${day}&to=${day}`, "time_entries", [], (items, _r) => {
        if (items && seq === dayFetchSeq) setDayEntries(dayTimeline(items.map(mapEntry)))
    })
}

// ------------------------------------------------------- polling engine

let fastTimer = 0
let slowTimer = 0
let baselineTimer = 0
let authStrikes = 0
let backoffLevel = 0
let lastSlowFetch = 0
// set by disposeSync(): a late response must not re-arm polling after
// teardown
let disposed = false

// delta sync state
let userId = 0
let highWater = 0 // ms epoch; from server updated_at values only
let seeded = false // the first baseline window has landed
// response ordering, per resource: a slower older poll must not
// overwrite a newer one *of the same query*. A single shared counter
// would let the window discard the running probe (and vice versa)
let requestSeq = 0
const lastApplied = { delta: 0, window: 0, running: 0 }
// lock gating + post-resume failure forgiveness
let locked = false
let forgiveFailuresUntil = 0

const BACKOFF_CAP = 600 // seconds

function effectiveInterval(): number {
    const base = (locked ? 60 : Config.harvest.pollInterval) * Math.pow(2, backoffLevel)
    return Math.min(base, BACKOFF_CAP)
}

export function scheduleNext(retryAfter = 0) {
    if (authDisabled.get() || disposed) return
    if (fastTimer) sourceRemove(fastTimer)
    const delay = Math.max(retryAfter, effectiveInterval())
    fastTimer = timeoutAddSeconds("harvest:deltaPoll", GLib.PRIORITY_DEFAULT, delay, () => {
        fastTimer = 0
        deltaPoll()
        return GLib.SOURCE_REMOVE
    })
}

function settleCycle(authFailed: boolean, failed: boolean, retryAfter = 0) {
    if (authFailed) {
        // one strike per cycle, not per request: a bad token fails every
        // request in the batch from one cause
        authStrikes++
        if (authStrikes >= 2) {
            disableAuth()
            return
        }
    } else {
        authStrikes = 0
    }
    // failures right after a resume/reconnect are the NIC coming up, not
    // an outage — don't back off for them
    if (failed && Date.now() > forgiveFailuresUntil) backoffLevel = Math.min(backoffLevel + 1, 5)
    else if (!failed) backoffLevel = 0
    scheduleNext(retryAfter)
}

// apply a delta response: upsert today's entries, advance the high-water
// mark (forward only), adopt running transitions
function applyDelta(entries: Entry[]) {
    const cur = running.get()
    const runningEntry = entries.find(e => e.isRunning)
    const today = localDay() // hoisted: one DateTime per delta, not per entry
    let transition = false
    let maxUpdated = highWater
    for (const e of entries) {
        const t = Date.parse(e.updatedAt)
        if (!Number.isNaN(t)) maxUpdated = Math.max(maxUpdated, t)
        if (e.spentDate === today) {
            // keep object identity when nothing actually changed:
            // gnim's For keys rows by reference, and a rebuild would
            // destroy an inline editor's state
            const existing = todayMap.get(e.id)
            todayMap.set(e.id, existing && existing.updatedAt === e.updatedAt ? existing : e)
        }
        if (e.isRunning) {
            if (cur?.id !== e.id) transition = true
        } else if (cur && e.id === cur.id) {
            transition = true
        }
    }
    highWater = maxUpdated
    if (runningEntry) adoptRunning(runningEntry)
    else if (cur && entries.some(e => e.id === cur.id)) adoptRunning(null)
    if (transition) fetchWindow()
    refreshStoppedFromMap()
}

// one small delta request per fast tick; the highWater-2s overlap kills
// the same-second boundary class and upserts are idempotent
let deltaInFlight = false

export function deltaPoll() {
    if (!active || authDisabled.get()) return
    if (!seeded) {
        scheduleNext()
        return
    }
    // coalesce: the scheduled tick, mutations, unlock, connectivity and
    // the popup can all trigger at once; one in flight is enough
    if (deltaInFlight) return
    deltaInFlight = true
    const seq = ++requestSeq
    const since = new Date(Math.max(0, highWater - 2000)).toISOString()
    const uid = userId ? `&user_id=${userId}` : ""
    request("GET", `/time_entries?updated_since=${encodeURIComponent(since)}${uid}`, null, r => {
        deltaInFlight = false
        // a throw while applying must not stall the loop: settle runs
        // either way
        try {
            if (r.ok && r.json && seq > lastApplied.delta) {
                lastApplied.delta = seq
                applyDelta((r.json.time_entries ?? []).map(mapEntry))
            }
        } finally {
            settleCycle(r.authFailed, !r.ok, r.retryAfter)
        }
    })
}

// the ±1d window: re-seeds the today map and resume targets. Fired on
// running transitions and as part of the baseline
function fetchWindow() {
    const seq = ++requestSeq
    request("GET", `/time_entries?from=${localDay(-1)}&to=${localDay(1)}`, null, r => {
        if (r.ok && r.json && seq > lastApplied.window) {
            lastApplied.window = seq
            const today = localDay()
            const fresh = new Map<number, Entry>()
            let maxUpdated = 0
            for (const raw of r.json.time_entries ?? []) {
                const e = mapEntry(raw)
                if (e.spentDate === today) fresh.set(e.id, e)
                const t = Date.parse(e.updatedAt)
                if (!Number.isNaN(t)) maxUpdated = Math.max(maxUpdated, t)
            }
            // a delta applied since this snapshot was taken is newer:
            // the window is authoritative for presence/deletion, but
            // per-entry the newer updatedAt wins. >=, not >: identical
            // entries keep their object identity, so gnim's For doesn't
            // rebuild the row (and destroy an editor's state) for no
            // data change
            for (const [id, e] of fresh) {
                const existing = todayMap.get(id)
                if (existing && existing.updatedAt >= e.updatedAt) fresh.set(id, existing)
            }
            todayMap.clear()
            for (const [id, e] of fresh) todayMap.set(id, e)
            // the high-water mark is seeded here once, then advanced by
            // deltas only (forward only, never from the baseline)
            if (!seeded) {
                highWater = maxUpdated || Date.now() - 5 * 60_000
                seeded = true
            }
            refreshStoppedFromMap()
        }
    })
}

// correctness floor: the unbounded running probe (weekend timer, missed
// stops) + the window (heals deletions and slipped deltas), every 5 min.
// the window goes first so the probe carries the newer sequence tag —
// otherwise a fast window response could discard the probe's adoption
function baseline() {
    if (!active || authDisabled.get()) return
    fetchWindow()
    const seq = ++requestSeq
    request("GET", "/time_entries?is_running=true", null, r => {
        if (r.ok && r.json && seq > lastApplied.running) {
            lastApplied.running = seq
            const raw = (r.json.time_entries ?? [])[0]
            adoptRunning(raw ? mapEntry(raw) : null)
            // this probe IS the baseline the banner latch waits for:
            // whatever it just adopted is state, and anything after it
            // is a real transition. Armed after the adoption, so the
            // adoption itself stays silent — and only on a successful
            // probe, so a failed one does not license a "timer started"
            // banner for a timer that has been running all morning
            armNotifications()
        }
    })
}

function slowCycle() {
    if (!active || authDisabled.get()) return
    lastSlowFetch = Date.now()
    // near-static: projects + tasks for the picker (cursor-paginated)
    fetchAll("/users/me/project_assignments", "project_assignments", [], (items, _r) => {
        if (items) {
            setProjects(
                items.map((a: any): Project => ({
                    projectId: a.project?.id ?? 0,
                    projectName: a.project?.name ?? "",
                    clientName: a.client?.name ?? "",
                    tasks: (a.task_assignments ?? [])
                        .filter((t: any) => t.is_active !== false)
                        .map((t: any) => ({
                            taskId: t.task?.id ?? 0,
                            taskName: t.task?.name ?? "",
                        })),
                })),
            )
        }
    })
    // wide window for the dropdown's recent project/task pairs
    fetchAll(
        `/time_entries?from=${localDay(-30)}&to=${localDay(1)}`,
        "time_entries",
        [],
        (items, _r) => {
            if (items) {
                const entries: Entry[] = items.map(mapEntry)
                const seen = new Set<string>()
                const pairs: Entry[] = []
                // API returns ascending spent_date; walk newest first
                for (const e of [...entries].reverse()) {
                    const key = `${e.projectId}/${e.taskId}`
                    if (seen.has(key)) continue
                    seen.add(key)
                    pairs.push(e)
                    if (pairs.length >= Math.max(Config.harvest.recents, 5)) break
                }
                setRecents(pairs)
            }
        },
    )
}

let rolloverTimer = 0

function msUntilMidnight(): number {
    const d = new Date()
    d.setHours(24, 0, 0, 0) // next local midnight
    return d.getTime() - Date.now() + 1000
}

// re-seed "today" at local midnight instead of waiting for the baseline
function armRollover() {
    if (rolloverTimer) sourceRemove(rolloverTimer)
    rolloverTimer = timeoutAdd("harvest:rollover", GLib.PRIORITY_DEFAULT, msUntilMidnight(), () => {
        rolloverTimer = 0
        fetchWindow()
        armRollover()
        return GLib.SOURCE_REMOVE
    })
}

function disableAuth() {
    if (authDisabled.get()) return
    setAuthDisabled(true)
    if (fastTimer) {
        sourceRemove(fastTimer)
        fastTimer = 0
    }
    if (slowTimer) {
        sourceRemove(slowTimer)
        slowTimer = 0
    }
    if (baselineTimer) {
        sourceRemove(baselineTimer)
        baselineTimer = 0
    }
    // the rollover re-arms itself every midnight: without this it keeps
    // firing one doomed 401 a day forever after the kill-switch trips
    if (rolloverTimer) {
        sourceRemove(rolloverTimer)
        rolloverTimer = 0
    }
    console.warn("Harvest: disabling after repeated authentication failures")
    notify(
        "Harvest authentication failed",
        "Check ~/.config/wam-shell/harvest.env — the widget is disabled until the shell restarts.",
    )
}

// older poll responses (any resource) must not resurrect pre-mutation
// state: mutations bump every resource's applied tag
export function invalidatePolls() {
    requestSeq++
    lastApplied.delta = requestSeq
    lastApplied.window = requestSeq
    lastApplied.running = requestSeq
}

// stale-while-revalidate when the picker popup opens; age-gated so
// fidgety toggling doesn't burn request quota
export function refreshSlow() {
    if (Date.now() - lastSlowFetch < 300_000) return
    slowCycle()
}

// -------------------------------------------------- lock + connectivity

// locked/suspended are the only states where nobody reads the panel:
// locked -> 60s ticks, unlock -> immediate poll. Watched via logind's
// LockedHint on our session; skipped when the process has no session.
function watchLock() {
    let pid = 0
    try {
        pid = Number(readFile("/proc/self/stat").split(" ")[0])
    } catch {
        return
    }
    // async from the start: no sync D-Bus round trips on the startup path
    Gio.DBus.system.call(
        "org.freedesktop.login1",
        "/org/freedesktop/login1",
        "org.freedesktop.login1.Manager",
        "GetSessionByPID",
        new GLib.Variant("(u)", [pid]),
        new GLib.VariantType("(o)"),
        Gio.DBusCallFlags.NONE,
        1000,
        null,
        (_conn, res) => {
            let sessionPath: string
            try {
                sessionPath = Gio.DBus.system.call_finish(res).get_child_value(0).get_string()[0]
            } catch {
                return // not in a registered session: no lock gating
            }
            Gio.DBus.system.call(
                "org.freedesktop.login1",
                sessionPath,
                "org.freedesktop.DBus.Properties",
                "Get",
                new GLib.Variant("(ss)", ["org.freedesktop.login1.Session", "LockedHint"]),
                new GLib.VariantType("(v)"),
                Gio.DBusCallFlags.NONE,
                1000,
                null,
                (_c2, res2) => {
                    try {
                        locked = Gio.DBus.system
                            .call_finish(res2)
                            .get_child_value(0)
                            .get_variant()
                            .get_boolean()
                    } catch (e) {
                        console.warn("Harvest: LockedHint read failed:", e)
                    }
                },
            )
            // disposeSync() may have run while these async calls were
            // in flight: subscribing now would leak the signal handler
            // (dispose already did its unsubscribe pass)
            if (disposed) return
            lockedHintSub = Gio.DBus.system.signal_subscribe(
                "org.freedesktop.login1",
                "org.freedesktop.DBus.Properties",
                "PropertiesChanged",
                sessionPath,
                "org.freedesktop.login1.Session",
                Gio.DBusSignalFlags.NONE,
                (_c, _s, _p, _i, _sig, params) => {
                    const v = params.get_child_value(1).lookup_value("LockedHint", null)
                    if (!v) return
                    const nowLocked = v.get_boolean()
                    if (nowLocked === locked) return
                    locked = nowLocked
                    if (!locked) deltaPoll()
                },
            )
        },
    )
}

// resume from suspend: poll on the connectivity edge, not the sleep
// signal (the NIC is still coming up then). Failures for ~30s after a
// resume or reconnect are forgiven, not backed off.
function watchConnectivity() {
    prepareSleepSub = Gio.DBus.system.signal_subscribe(
        "org.freedesktop.login1",
        "org.freedesktop.login1.Manager",
        "PrepareForSleep",
        null,
        null,
        Gio.DBusSignalFlags.NONE,
        (_c, _s, _p, _i, _sig, params) => {
            if (!params.get_child_value(0).get_boolean()) {
                forgiveFailuresUntil = Date.now() + 30_000
            }
        },
    )
    const net = AstalNetwork.get_default()
    connectivityHandler = connect(net, "notify::connectivity", () => {
        if (net.connectivity !== AstalNetwork.Connectivity.FULL) return
        forgiveFailuresUntil = Date.now() + 30_000
        deltaPoll()
    })
}

let lockedHintSub = 0
let prepareSleepSub = 0
let connectivityHandler = 0

export function disposeSync() {
    disposed = true
    if (fastTimer) {
        sourceRemove(fastTimer)
        fastTimer = 0
    }
    if (slowTimer) {
        sourceRemove(slowTimer)
        slowTimer = 0
    }
    if (baselineTimer) {
        sourceRemove(baselineTimer)
        baselineTimer = 0
    }
    if (rolloverTimer) {
        sourceRemove(rolloverTimer)
        rolloverTimer = 0
    }
    if (lockedHintSub) {
        Gio.DBus.system.signal_unsubscribe(lockedHintSub)
        lockedHintSub = 0
    }
    if (prepareSleepSub) {
        Gio.DBus.system.signal_unsubscribe(prepareSleepSub)
        prepareSleepSub = 0
    }
    if (connectivityHandler) {
        disconnect(AstalNetwork.get_default(), connectivityHandler)
        connectivityHandler = 0
    }
}

// -------------------------------------------------------------- startup

// explicit entry point (called from app.tsx): keeps network I/O out of
// module import and makes startup ordering visible
export function init() {
    if (!active) return
    let pending = 2
    let authFailed = false
    const startupDone = () => {
        if (--pending > 0) return
        if (authFailed) {
            authStrikes++ // the whole startup pair is ONE strike
            if (authStrikes >= 2) {
                disableAuth()
                return
            }
        }
        baseline() // also seeds the high-water mark
        slowCycle()
        slowTimer = timeoutAddSeconds("harvest:slowCycle", GLib.PRIORITY_DEFAULT, 30 * 60, () => {
            slowCycle()
            return GLib.SOURCE_CONTINUE
        })
        baselineTimer = timeoutAddSeconds("harvest:baseline", GLib.PRIORITY_DEFAULT, 5 * 60, () => {
            baseline()
            return GLib.SOURCE_CONTINUE
        })
        watchLock()
        watchConnectivity()
        armRollover()
        scheduleNext() // delta loop; self-gates until seeded
    }

    request("GET", "/users/me", null, r => {
        if (r.ok && r.json) {
            userId = Number(r.json.id) || 0
            console.log(`Harvest: account timezone: ${r.json.timezone ?? "unknown"}`)
        }
        authFailed ||= r.authFailed
        startupDone()
    })

    request("GET", "/company", null, r => {
        if (r.ok && r.json) {
            accountMode.wantsTimestampTimers = !!r.json.wants_timestamp_timers
            accountMode.accountClock = r.json.clock === "24h" ? "24h" : "12h"
            accountMode.timeFormat = r.json.time_format === "decimal" ? "decimal" : "hours_minutes"
        } else if (r.status === 403) {
            // company is admin-only on some accounts: use defaults instead
            // of counting this as an auth strike
            console.warn("Harvest: /company not permitted; assuming duration timers + 12h clock")
        } else {
            authFailed ||= r.authFailed
        }
        startupDone()
    })
}
