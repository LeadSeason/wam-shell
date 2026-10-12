// Do-not-disturb snooze: turn DND on for a while, get the silence back
// afterwards without having to remember to undo it. Two kinds of hold
// can keep DND up, and they may overlap:
//
//   timed    — armed from the center's DND menu ("snooze 45 minutes");
//              restores the pre-snooze state when the deadline passes
//   sharing  — the standing "snooze while screen sharing" preference
//              meeting a live capture: engaged for as long as both are
//              true, so it needs no deadline of its own
//
// AstalNotifd carries ONE persisted boolean (`dontDisturb`, gsettings),
// so what the user actually meant cannot live there. This module owns
// the meaning: the resting value DND returns to, the holds over it, and
// the one boolean the daemon should currently read. The events below
// are the whole decision table; lib/notifd applies them (state, timer,
// the gsettings write) and the unit suite pins them.
//
// Kept import-safe (no Astal, no GLib, no Config) so the tests can load
// it directly — the notifd module instantiates the daemon at import.

/** The snooze state. `until` is a wall-clock unix ms deadline (the
 *  center's relative-time clock compares in the same terms). */
export interface DndSnoozeState {
    /** what DND returns to once every hold has lifted */
    resting: boolean
    /** deadline of the timed hold; null when none is armed */
    until: number | null
    /** last known capture state (captureWatch.sharing) */
    sharing: boolean
    /** the standing "snooze while screen sharing" preference */
    auto: boolean
}

export function initialDndSnoozeState(resting: boolean, auto: boolean): DndSnoozeState {
    return { resting, until: null, sharing: false, auto }
}

/** DND is wanted while any hold is up: a timed snooze, or the share
 *  hold (the preference AND a capture running). */
export function dndWanted(s: DndSnoozeState): boolean {
    return s.resting || s.until !== null || (s.auto && s.sharing)
}

/** What an event decided: the next state, and the boolean to write to
 *  the daemon (the caller skips no-op writes). */
export interface Applied {
    next: DndSnoozeState
    set: boolean
}

function apply(s: DndSnoozeState, patch: Partial<DndSnoozeState>): Applied {
    const next = { ...s, ...patch }
    return { next, set: dndWanted(next) }
}

/** Arm (or re-arm) the timed snooze. The resting value is untouched —
 *  re-arming mid-snooze just moves the deadline, and arming over a
 *  permanently-on DND still returns to on. */
export function armSnooze(s: DndSnoozeState, minutes: number, nowMs: number): Applied {
    return apply(s, { until: nowMs + minutes * 60_000 })
}

/** Drop the timed hold (menu "Cancel snooze", or any path that must
 *  forget the deadline without changing who wants DND). */
export function clearSnooze(s: DndSnoozeState): Applied {
    if (s.until === null) return { next: s, set: dndWanted(s) }
    return apply(s, { until: null })
}

/** The timed hold's deadline passed. */
export function expireSnooze(s: DndSnoozeState): Applied {
    return clearSnooze(s)
}

/** The user clicked the DND toggle. The click is the newest intent and
 *  overrides everything: holds are dropped (and a share hold active at
 *  that moment also unticks the standing preference — left armed it
 *  would re-engage on the next capture, undoing what the user just
 *  asked for). The toggle acts on what the user SEES, the effective
 *  state, not on the resting value. */
export function manualToggle(s: DndSnoozeState): Applied {
    const wanted = !dndWanted(s)
    const next: DndSnoozeState = { ...s, until: null, resting: wanted }
    if (next.auto && next.sharing) next.auto = false
    return { next, set: dndWanted(next) }
}

/** The standing share-snooze preference changed (menu checkbox). */
export function setShareSnooze(s: DndSnoozeState, on: boolean): Applied {
    return apply(s, { auto: on })
}

/** A capture started or ended (captureWatch.sharing). */
export function setSharing(s: DndSnoozeState, sharing: boolean): Applied {
    return apply(s, { sharing })
}

/** "45m" / "1h" / "1h 30m" — menu item labels. */
export function formatMinutes(minutes: number): string {
    const h = Math.floor(minutes / 60)
    const m = Math.round(minutes % 60)
    if (h === 0) return `${m}m`
    return m === 0 ? `${h}h` : `${h}h ${m}m`
}

/** Time left on the timed hold, rounded UP (a countdown that says
 *  "1m" while time is still left; never "0m" before the deadline). */
export function formatRemaining(msLeft: number): string {
    if (msLeft <= 0) return formatMinutes(0)
    return formatMinutes(Math.ceil(msLeft / 60_000))
}
