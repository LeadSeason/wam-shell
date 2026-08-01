// Sleep timer persistence state: what crosses a shell restart. Kept
// import-safe (no Astal imports) so the unit tests can load it — the
// timer module itself calls AstalMpris.get_default() at import, which
// the test harness forbids.

export interface SleepTimerState {
    deadline: number | null // wall-clock ms; null = no timer
    paused: boolean
    pausedSeconds: number // frozen remainder while paused
    // set by fire() so a restart still knows the pre-dim level
    dim: { pre: number; to: number } | null
}

export function serialize(state: SleepTimerState): string {
    return JSON.stringify(state)
}

// null on any malformed input: a broken file is simply no state
export function parse(text: string): SleepTimerState | null {
    try {
        const s = JSON.parse(text)
        if (typeof s !== "object" || s === null) return null
        const deadline =
            s.deadline === null || typeof s.deadline === "number" ? s.deadline : undefined
        if (deadline === undefined) return null
        const dim =
            s.dim && typeof s.dim.pre === "number" && typeof s.dim.to === "number" ? s.dim : null
        return {
            deadline,
            paused: s.paused === true,
            pausedSeconds: typeof s.pausedSeconds === "number" ? s.pausedSeconds : 0,
            dim,
        }
    } catch {
        return null
    }
}

export type LoadDecision =
    | "owned" // a live shell owns the timer (fresh file): do nothing
    | "live" // deadline in the future: adopt and keep ticking
    | "paused" // frozen remainder: restore paused
    | "expired" // deadline passed while away: notify once, discard
    | "dim-only" // fired before the restart: only dim restore remains
    | "empty" // nothing to adopt

// decide what a starting shell should do with a state file. nowMs =
// current wall clock; mtimeMs = the file's mtime (its freshness is the
// owner's liveness beacon); staleMs = how old a file may be before it
// is considered abandoned
export function decide(
    state: SleepTimerState | null,
    nowMs: number,
    mtimeMs: number | null,
    staleMs = 3000,
): LoadDecision {
    if (state === null) return "empty"
    if (mtimeMs !== null && nowMs - mtimeMs < staleMs) return "owned"
    if (state.paused) return "paused"
    if (state.deadline !== null) return state.deadline > nowMs ? "live" : "expired"
    if (state.dim) return "dim-only"
    return "empty"
}
