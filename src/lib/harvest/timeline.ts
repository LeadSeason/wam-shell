import GLib from "gi://GLib?version=2.0"
import { accountMode } from "./account"

// the Harvest data model and the pure date/timeline math over it: no
// HTTP, no gnim state, no timers. dayTimeline/startTimeLabel are covered
// by tests/harvestTimeline.test.ts

// ---------------------------------------------------------------- types

export interface Entry {
    id: number
    spentDate: string // "YYYY-MM-DD"
    hours: number
    hoursWithoutTimer: number | null
    timerStartedAt: string | null // ISO 8601
    startedTime: string | null // "3:00pm" or "15:00"
    isRunning: boolean
    notes: string
    createdAt: string
    updatedAt: string
    projectId: number
    projectName: string
    taskId: number
    taskName: string
    clientName: string
}

export interface Project {
    projectId: number
    projectName: string
    clientName: string
    tasks: { taskId: number; taskName: string }[]
}

// ------------------------------------------------------------- helpers

export function localDay(offsetDays = 0): string {
    const now = GLib.DateTime.new_now_local()
    const day = offsetDays ? now.add_days(offsetDays)! : now
    return day.format("%Y-%m-%d")!
}

// start of the running segment in ms, tolerating both account modes
export function startMs(e: Entry): number | null {
    if (e.timerStartedAt) {
        const t = Date.parse(e.timerStartedAt)
        if (!Number.isNaN(t)) return t
    }
    if (e.startedTime) {
        // accepts the account's clock format and the other one too
        const m =
            e.startedTime.trim().match(/^(\d{1,2}):(\d{2})\s*([ap])\.?m\.?$/i) ??
            e.startedTime.trim().match(/^(\d{1,2}):(\d{2})$/)
        if (m) {
            let h = Number(m[1])
            const min = Number(m[2])
            const ap = m[3]?.toLowerCase()
            if (ap === "p" && h < 12) h += 12
            if (ap === "a" && h === 12) h = 0
            const [y, mo, d] = e.spentDate.split("-").map(Number)
            if (y && mo && d) return new Date(y, mo - 1, d, h, min).getTime()
        }
    }
    return null
}

export function liveSeconds(e: Entry): number {
    // hours already includes the live segment for a running entry, so
    // without hours_without_timer the only safe base is 0
    const base = (e.hoursWithoutTimer ?? 0) * 3600
    const start = startMs(e)
    if (start === null) return base
    return base + Math.max(0, (Date.now() - start) / 1000)
}

export function formatElapsed(seconds: number): string {
    // honor the account's Time Format setting (company.time_format)
    if (accountMode.timeFormat === "decimal") return (seconds / 3600).toFixed(2)
    const totalMin = Math.floor(seconds / 60)
    const h = Math.floor(totalMin / 60)
    const m = totalMin % 60
    return `${h}:${m.toString().padStart(2, "0")}`
}

export function mapEntry(e: any): Entry {
    return {
        id: e.id ?? 0,
        spentDate: e.spent_date ?? "",
        hours: e.hours ?? 0,
        hoursWithoutTimer: e.hours_without_timer ?? null,
        timerStartedAt: e.timer_started_at ?? null,
        startedTime: e.started_time ?? null,
        isRunning: !!e.is_running,
        notes: e.notes ?? "",
        createdAt: e.created_at ?? "",
        updatedAt: e.updated_at ?? "",
        projectId: e.project?.id ?? 0,
        projectName: e.project?.name ?? "",
        taskId: e.task?.id ?? 0,
        taskName: e.task?.name ?? "",
        clientName: e.client?.name ?? "",
    }
}

// timeline order for the popup: by entry creation, oldest first —
// Harvest's own day view logs entries where they were CREATED (the
// running entry does not jump to the top when resumed). created_at is
// the entry's birth; start times are only the display label. Ties
// break by id (entries are created in id order anyway)
export function dayTimeline(entries: Entry[]): Entry[] {
    const ms = (s: string) => {
        const t = Date.parse(s)
        return Number.isNaN(t) ? 0 : t
    }
    return [...entries].sort(
        (a, b) =>
            (ms(a.createdAt) || ms(a.updatedAt)) - (ms(b.createdAt) || ms(b.updatedAt)) ||
            a.id - b.id,
    )
}

// "HH:MM" (24h) for a timeline row, "" for manual entries with no start
export function startTimeLabel(e: Entry): string {
    const ms = startMs(e)
    if (ms === null) return ""
    const d = new Date(ms)
    const hh = String(d.getHours()).padStart(2, "0")
    const mm = String(d.getMinutes()).padStart(2, "0")
    return `${hh}:${mm}`
}

// today's portion of the running entry: hours accrued before midnight
// don't count toward today's total
export function todaySeconds(e: Entry): number {
    const base =
        e.spentDate === localDay()
            ? // same live-segment double-count rule as liveSeconds
              (e.hoursWithoutTimer ?? 0) * 3600
            : 0
    const start = startMs(e)
    if (start === null) return base
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    return base + Math.max(0, (Date.now() - Math.max(start, midnight.getTime())) / 1000)
}
