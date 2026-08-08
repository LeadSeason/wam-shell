// Harvest time tracking (api v2). The widget mirrors timers that live on
// Harvest's servers: nothing here owns a timer, a shell restart simply
// re-syncs. Fast poll = the volatile stuff (running probe + today's
// entries), slow poll = near-static stuff (project assignments, wide
// recents window). All date math is local; the ±1d query widening makes
// the server-side spent_date filter timezone-insensitive.
//
// Facade over the harvest/ modules, so importers keep one entry point:
//   timeline.ts  data model + pure date/timeline math (unit-tested)
//   account.ts   company settings holder (clock/time format/timer mode)
//   api.ts       credential gate + HTTP plumbing
//   state.ts     gnim states, the today map, the elapsed ticker
//   sync.ts      polling engine, lock/connectivity gating, init
//   actions.ts   user-initiated mutations (start/stop/pause/resume/edit)

export type { Entry, Project } from "./harvest/timeline"
export { dayTimeline, startTimeLabel, formatElapsed } from "./harvest/timeline"
export { timerBanner } from "./harvest/notify"
export { active } from "./harvest/api"
export {
    running,
    elapsed,
    dayTotal,
    projects,
    recents,
    lastStopped,
    recentStopped,
    todayEntries,
    paused,
    busy,
    authDisabled,
    dayEntries,
} from "./harvest/state"
export { fetchDayOffset, deltaPoll, refreshSlow, init } from "./harvest/sync"
export {
    stopRunning,
    pauseTimer,
    addEntry,
    startTimer,
    resumeEntry,
    resumeLast,
    setNotes,
    setEntryNotes,
    updateEntry,
    setHours,
    deleteEntry,
} from "./harvest/actions"

import { disposeHttp } from "./harvest/api"
import { disposeSync } from "./harvest/sync"
import { disposeState } from "./harvest/state"
import { registerDispose } from "./lifecycle"

// convention for lib modules with long-lived sources, even though the
// shell never calls it today: one place that tears everything down
export function dispose() {
    disposeHttp()
    disposeSync()
    disposeState()
}

// tear-down entry point, run from app.tsx on shutdown (lib/lifecycle)
registerDispose("harvest", dispose)
