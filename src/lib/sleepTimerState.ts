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
    // sink-input streams muted at fire (the MPRIS-invisible audio
    // fallback): a restart must still be able to unmute what the
    // previous shell muted, or the streams stay muted forever
    mutedStreams: number[]
    // owning shell's PID: how a starting shell tells a live owner from
    // a crashed one — a dead pid means the file is abandoned (0 =
    // unknown)
    pid: number
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
            // absent in files predating the field
            mutedStreams: Array.isArray(s.mutedStreams)
                ? s.mutedStreams.filter((id: unknown) => typeof id === "number")
                : [],
            pid: typeof s.pid === "number" ? s.pid : 0,
        }
    } catch {
        return null
    }
}

export type LoadDecision =
    | "owned" // a live shell owns the timer (live owner pid): do nothing
    | "live" // deadline in the future: adopt and keep ticking
    | "paused" // frozen remainder: restore paused
    | "expired" // deadline passed while away: notify once, discard
    | "dim-only" // fired before the restart: only dim restore remains
    | "empty" // nothing to adopt

// decide what a starting shell should do with a state file. nowMs =
// current wall clock; ownerAlive = the recorded owner pid still
// belongs to a live shell process. The owner pid is the liveness
// signal: a live owner means hands off, a dead one means the file is
// a crash/kill leftover and is adopted (never dropped). The adoption
// claim is an atomic rename, so two racing starts can't double-fire.
export function decide(
    state: SleepTimerState | null,
    nowMs: number,
    ownerAlive = false,
): LoadDecision {
    if (state === null) return "empty"
    if (ownerAlive) return "owned"
    if (state.paused) return "paused"
    if (state.deadline !== null) return state.deadline > nowMs ? "live" : "expired"
    if (state.dim) return "dim-only"
    return "empty"
}
