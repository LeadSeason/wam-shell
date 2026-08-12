import GLib from "gi://GLib?version=2.0"
import { Entry, mapEntry, localDay, startMs } from "./timeline"
import { request } from "./api"
import { accountMode } from "./account"
import {
    running,
    paused,
    setPaused,
    recentStopped,
    recents,
    setBusy,
    authDisabled,
    todayMap,
    adoptRunning,
    refreshStoppedFromMap,
} from "./state"
import { deltaPoll, scheduleNext, invalidatePolls } from "./sync"

// user-initiated mutations against the API: start/stop/pause/resume and
// entry edits. Serialized: one mutation in flight, further clicks
// ignored while busy; the poll backoff never applies here, clicks fire
// immediately. Sync loops live in sync.ts

let mutInFlight = false

function mutate(work: (done: (resync?: boolean) => void) => void) {
    if (mutInFlight || authDisabled.get()) return
    mutInFlight = true
    setBusy(true)
    invalidatePolls()
    work((resync = false) => {
        mutInFlight = false
        setBusy(false)
        // most mutation responses are authoritative; only startTimer
        // needs a follow-up (to catch the auto-stopped predecessor)
        if (resync) deltaPoll()
        else scheduleNext()
    })
}

export function stopRunning() {
    const cur = running.get()
    if (!cur) return
    mutate(done => {
        request("PATCH", `/time_entries/${cur.id}/stop`, null, r => {
            try {
                if (r.ok && r.json) {
                    // the response is authoritative: day total and resume
                    // targets update immediately, not at the next tick
                    const e = mapEntry(r.json)
                    todayMap.set(e.id, e)
                    refreshStoppedFromMap()
                    adoptRunning(null)
                } else console.warn(`Harvest: stop failed (status ${r.status})`)
            } finally {
                done()
            }
        })
    })
}

// stop with intent to resume: same API call, but the entry is kept as the
// prominent resume target
export function pauseTimer() {
    const cur = running.get()
    if (!cur) return
    mutate(done => {
        request("PATCH", `/time_entries/${cur.id}/stop`, null, r => {
            try {
                if (r.ok && r.json) {
                    const e = mapEntry(r.json)
                    setPaused(e)
                    todayMap.set(e.id, e)
                    refreshStoppedFromMap()
                    adoptRunning(null)
                } else console.warn(`Harvest: pause failed (status ${r.status})`)
            } finally {
                done()
            }
        })
    })
}

const clockFmt = () => (accountMode.accountClock === "24h" ? "%H:%M" : "%-I:%M%p")

function createEntry(
    projectId: number,
    taskId: number,
    done: (ok: boolean) => void,
    notes?: string,
) {
    const body: Record<string, any> = {
        project_id: projectId,
        task_id: taskId,
        spent_date: localDay(),
    }
    if (notes) body.notes = notes
    // timestamp accounts: started_time defaults to now, ended_time omitted
    // leaves it running; duration accounts: no hours = running
    if (accountMode.wantsTimestampTimers) {
        body.started_time = GLib.DateTime.new_now_local().format(clockFmt())!.toLowerCase()
    }
    request("POST", "/time_entries", body, r => {
        try {
            if (r.ok && r.json) adoptRunning(mapEntry(r.json))
        } finally {
            done(r.ok)
        }
    })
}

// a completed entry with explicit hours; does not disturb the running timer
export function addEntry(projectId: number, taskId: number, hours: number, notes?: string) {
    if (hours <= 0) return
    mutate(done => {
        const body: Record<string, any> = {
            project_id: projectId,
            task_id: taskId,
            spent_date: localDay(),
        }
        if (notes) body.notes = notes
        if (accountMode.wantsTimestampTimers) {
            // start/end form: derive the window from the duration
            const end = GLib.DateTime.new_now_local()
            const start = end.add_seconds(-Math.round(hours * 3600))!
            body.started_time = start.format(clockFmt())!.toLowerCase()
            body.ended_time = end.format(clockFmt())!.toLowerCase()
        } else {
            body.hours = hours
        }
        request("POST", "/time_entries", body, r => {
            try {
                if (!r.ok) console.warn(`Harvest: add entry failed (status ${r.status})`)
            } finally {
                done()
            }
        })
    })
}

export function startTimer(projectId: number, taskId: number, notes?: string) {
    // single call: verified against the live API that POST auto-stops the
    // currently running entry, so no stop-first / rollback dance is needed
    mutate(done => {
        createEntry(projectId, taskId, () => done(true), notes)
    })
}

// Harvest's native resume. Verified against the live API: restart keeps
// the same entry id (hours accumulate on the same row); the response body
// is adopted as-is either way
export function resumeEntry(entry: Entry) {
    if (entry.isRunning) return
    mutate(done => {
        request("PATCH", `/time_entries/${entry.id}/restart`, null, r => {
            try {
                if (r.ok && r.json) adoptRunning(mapEntry(r.json))
                else console.warn(`Harvest: restart failed (status ${r.status})`)
            } finally {
                // a restart auto-stops any previously running entry
                // server-side; resync to catch its final state
                done(true)
            }
        })
    })
}

export function resumeLast() {
    const target = paused.get() ?? recentStopped.get()[0] ?? recents.get()[0] ?? null
    if (target) resumeEntry(target)
}

// false when the update could not even be attempted (busy/disabled), so
// the notes field keeps its dirty state instead of silently dropping text
export function setNotes(text: string, onDone?: (ok: boolean) => void): boolean {
    const cur = running.get()
    if (!cur) return false
    return setEntryNotes(cur, text, onDone)
}

// edit the notes of any entry, running or stopped. Same return contract
// as setNotes: false = not attempted, the field stays dirty
export function setEntryNotes(entry: Entry, text: string, onDone?: (ok: boolean) => void): boolean {
    return updateEntry(entry, { notes: text }, onDone)
}

// one PATCH carrying every changed field (notes and/or project/task
// reassignment). The client moves implicitly: it is a property of the
// project, so "editing the client" means picking another project. A
// project move must name a task assigned to that project (task ids are
// account-wide, so the same task id is usually valid there). Same
// return contract as setNotes: false = not attempted, fields stay dirty
export function updateEntry(
    entry: Entry,
    fields: { notes?: string; projectId?: number; taskId?: number },
    onDone?: (ok: boolean) => void,
): boolean {
    const body: Record<string, any> = {}
    if (fields.notes !== undefined && fields.notes !== entry.notes) body.notes = fields.notes
    if (
        fields.projectId !== undefined &&
        fields.projectId !== entry.projectId &&
        fields.taskId !== undefined &&
        fields.taskId > 0
    ) {
        body.project_id = fields.projectId
        body.task_id = fields.taskId
    } else if (fields.taskId !== undefined && fields.taskId !== entry.taskId && fields.taskId > 0) {
        body.task_id = fields.taskId
    }
    // nothing to send: this includes a reassignment to a project with
    // zero tasks (taskId 0 drops both ids above). Still report success
    // so the caller clears its dirty state instead of leaving Save
    // visible with no feedback
    if (Object.keys(body).length === 0) {
        onDone?.(true)
        return true
    }
    if (mutInFlight || authDisabled.get()) return false
    mutate(done => {
        request("PATCH", `/time_entries/${entry.id}`, body, r => {
            try {
                if (r.ok && r.json) {
                    const e = mapEntry(r.json)
                    if (e.isRunning) {
                        adoptRunning(e)
                        // keep the timeline's running row in sync too
                        if (e.spentDate === localDay()) {
                            todayMap.set(e.id, e)
                            refreshStoppedFromMap()
                        }
                    } else {
                        if (e.spentDate === localDay()) todayMap.set(e.id, e)
                        refreshStoppedFromMap()
                        if (paused.get()?.id === e.id) setPaused(e)
                    }
                } else console.warn(`Harvest: entry update failed (status ${r.status})`)
                onDone?.(r.ok)
            } finally {
                done()
            }
        })
    })
    return true
}

// edit the accrued time of a stopped entry (the paused one in the UI).
// Duration accounts PATCH raw hours; timestamp accounts get the same
// duration expressed as a started/ended window instead. Same return
// contract as setNotes: false = not attempted, the field stays dirty
export function setHours(entry: Entry, hours: number, onDone?: (ok: boolean) => void): boolean {
    // the server stores hundredths of an hour
    hours = Math.round(hours * 100) / 100
    if (hours <= 0 || entry.isRunning || mutInFlight || authDisabled.get()) return false
    mutate(done => {
        const body: Record<string, any> = {}
        if (accountMode.wantsTimestampTimers) {
            const start = startMs(entry)
            if (start !== null) {
                const fmt = (ms: number) =>
                    GLib.DateTime.new_from_unix_local(Math.round(ms / 1000))
                        .format(clockFmt())!
                        .toLowerCase()
                body.started_time = fmt(start)
                body.ended_time = fmt(start + hours * 3_600_000)
            } else {
                // no parseable start to hang a window on; raw hours may
                // still be accepted
                body.hours = hours
            }
        } else {
            body.hours = hours
        }
        request("PATCH", `/time_entries/${entry.id}`, body, r => {
            try {
                if (r.ok && r.json) {
                    const e = mapEntry(r.json)
                    if (e.spentDate === localDay()) todayMap.set(e.id, e)
                    refreshStoppedFromMap()
                    if (paused.get()?.id === e.id) setPaused(e)
                } else console.warn(`Harvest: hours update failed (status ${r.status})`)
                onDone?.(r.ok)
            } finally {
                done()
            }
        })
    })
    return true
}

// delete an entry from Harvest. The UI confirms with the user before
// calling this. Same return contract as setEntryNotes: false = not
// attempted (busy/disabled)
export function deleteEntry(entry: Entry): boolean {
    if (mutInFlight || authDisabled.get()) return false
    mutate(done => {
        request("DELETE", `/time_entries/${entry.id}`, null, r => {
            try {
                if (r.ok) {
                    // local state is authoritative until the next full
                    // reseed (the delta poll can't observe deletions)
                    todayMap.delete(entry.id)
                    refreshStoppedFromMap()
                    if (paused.get()?.id === entry.id) setPaused(null)
                    if (running.get()?.id === entry.id) adoptRunning(null)
                } else console.warn(`Harvest: delete failed (status ${r.status})`)
            } finally {
                done()
            }
        })
    })
    return true
}
