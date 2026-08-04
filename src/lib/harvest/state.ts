import GLib from "gi://GLib?version=2.0"
import { createState } from "gnim"
import { timeoutAdd, sourceRemove } from "../metrics"
import { Entry, Project, dayTimeline, liveSeconds, todaySeconds } from "./timeline"
import { accountMode } from "./account"

// gnim states + the today map everything derives from, and the elapsed
// ticker. No HTTP: sync.ts pushes server data in, widgets read out

// ---------------------------------------------------------------- state

const [running, setRunning] = createState<Entry | null>(null)
export { running }
// live seconds of the running entry, ticked locally every second
const [elapsed, setElapsed] = createState(0)
export { elapsed }
// today's total in seconds (live running time included)
const [dayTotal, setDayTotal] = createState(0)
export { dayTotal }
const [projects, setProjects] = createState<Project[]>([])
export { projects, setProjects }
// recent entries deduped by project/task, most recent first
const [recents, setRecents] = createState<Entry[]>([])
export { recents, setRecents }
const [lastStopped, setLastStopped] = createState<Entry | null>(null)
export { lastStopped }
// today's stopped entries, most recently updated first (resume targets)
const [recentStopped, setRecentStopped] = createState<Entry[]>([])
export { recentStopped }
// the full day as a timeline for the popup: every entry of today,
// ascending by start time (see dayTimeline)
const [todayEntries, setTodayEntries] = createState<Entry[]>([])
export { todayEntries }
// an entry the user "paused": stopped with intent to resume. Purely a UI
// distinction — the API only knows start/stop, and restart keeps
// accumulating on the same row (verified against the live API). Cleared
// whenever any timer starts, here or elsewhere.
const [paused, setPaused] = createState<Entry | null>(null)
export { paused, setPaused }
const [busy, setBusy] = createState(false)
export { busy, setBusy }
const [authDisabled, setAuthDisabled] = createState(false)
export { authDisabled, setAuthDisabled }

// entries of an arbitrary past day, for the popup's day browser.
// Today is served live by todayEntries, so only other days are fetched
const [dayEntries, setDayEntries] = createState<Entry[]>([])
export { dayEntries, setDayEntries }

// ------------------------------------------------- derived from today

// today's entries keyed by id: the sync window is authoritative for
// presence/deletion, deltas and mutation replies upsert into it
export const todayMap = new Map<number, Entry>()

// identity churn rebuilds the popup header (and its notes field) under
// the user; skip adoption when nothing material changed
function sameEntry(a: Entry | null, b: Entry | null): boolean {
    if (a === b) return true
    if (!a || !b) return false
    return (
        a.id === b.id &&
        a.updatedAt === b.updatedAt &&
        a.isRunning === b.isRunning &&
        a.notes === b.notes
    )
}

export function adoptRunning(entry: Entry | null) {
    const prev = running.get()
    if (sameEntry(prev, entry)) return
    setRunning(entry)
    if (entry) {
        // a timer running means nothing is paused anymore
        setPaused(null)
        // keep ticking from the server's numbers, not our stale ones
        setElapsed(liveSeconds(entry))
        armTicker()
    } else {
        setElapsed(0)
        disarmTicker()
    }
    if (prev?.id !== entry?.id) refreshDayTotal()
}

let stoppedTodaySec = 0

export function refreshStoppedFromMap() {
    const stopped = [...todayMap.values()]
        .filter(e => !e.isRunning)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    stoppedTodaySec = stopped.reduce((sum, e) => sum + e.hours * 3600, 0)
    refreshDayTotal()
    setLastStopped(stopped[0] ?? null)
    setRecentStopped(stopped.slice(0, 3))
    // a fresh array notifies gnim's For even when nothing changed, and
    // it rebuilds every row (~every poll tick) — steal focus and churn
    // hover/scroll for zero data change. Emit only on real change.
    const timeline = dayTimeline([...todayMap.values()])
    const prev = todayEntries.get()
    if (
        prev.length !== timeline.length ||
        prev.some((e, i) => e.id !== timeline[i].id || e.updatedAt !== timeline[i].updatedAt)
    )
        setTodayEntries(timeline)
}

function refreshDayTotal() {
    const cur = running.get()
    setDayTotal(stoppedTodaySec + (cur ? todaySeconds(cur) : 0))
}

// ------------------------------------------------------------- ticker

// the displayed string changes at most once per 36s (decimal) or 60s
// (h:mm): schedule exactly those instants instead of a 1 Hz ticker
function msUntilNextChange(sec: number): number {
    const period = accountMode.timeFormat === "decimal" ? 36_000 : 60_000
    return Math.max(250, period - ((sec * 1000) % period))
}

let tickerSource = 0

function armTicker() {
    if (tickerSource) return
    const fire = () => {
        tickerSource = 0
        const cur = running.get()
        if (!cur) return GLib.SOURCE_REMOVE
        const secs = liveSeconds(cur)
        setElapsed(secs)
        refreshDayTotal()
        tickerSource = timeoutAdd(
            "harvest:ticker",
            GLib.PRIORITY_DEFAULT,
            msUntilNextChange(secs),
            fire,
        )
        return GLib.SOURCE_REMOVE
    }
    const cur = running.get()
    if (cur) {
        tickerSource = timeoutAdd(
            "harvest:ticker",
            GLib.PRIORITY_DEFAULT,
            msUntilNextChange(liveSeconds(cur)),
            fire,
        )
    }
}

function disarmTicker() {
    if (tickerSource) {
        sourceRemove(tickerSource)
        tickerSource = 0
    }
}

export function disposeState() {
    disarmTicker()
}
