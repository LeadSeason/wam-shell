import { execAsync } from "./metrics"

// Hyprland changed how `hyprctl dispatch` reads its arguments. 0.55
// introduced a Lua grammar and 0.56 speaks ONLY that: on 0.56.1 the
// familiar `hyprctl dispatch workspace 2` answers
//
//     error: [string "return hl.dispatch(workspace 2)"]:1: ')' expected near '2'
//
// while `hyprctl dispatch 'hl.dsp.focus({workspace="2"})'` answers ok.
// Older releases are the exact reverse.
//
// The shell shipped the Lua form hard-coded, so clicking a workspace on
// an older Hyprland did nothing at all — hyprctl exits non-zero, the
// rejection went to console.error, and under autostart that lands in
// the journal where nobody was looking.
//
// Rather than pin the cutover release, try one form and fall back to the
// other, then remember which answered. Version detection would mean
// parsing `hyprctl version` and keeping a table in step with Hyprland
// releases forever; the dispatcher already tells us, for free, by
// failing. The fallback costs one extra spawn once per session on old
// Hyprland, and nothing at all after that.

export type DispatchForm = "lua" | "legacy"

type Exec = (argv: string[]) => Promise<string>

export interface Dispatcher {
    /** run a dispatch, in whichever grammar this Hyprland understands.
     *  @param lua the argument for 0.55+, e.g. `hl.dsp.focus({workspace="2"})`
     *  @param legacy the pre-0.55 argv, e.g. ["workspace", "2"] */
    (lua: string, legacy: string[]): Promise<void>
    /** which grammar answered, or null before the first successful call.
     *  Exposed for the tests and for `wam status` to report */
    form: DispatchForm | null
}

export function createDispatcher(exec: Exec, warn: (msg: string) => void = () => {}): Dispatcher {
    const lua = (arg: string) => exec(["hyprctl", "dispatch", arg])
    const legacy = (argv: string[]) => exec(["hyprctl", "dispatch", ...argv])

    const dispatch = (async (luaArg: string, legacyArgv: string[]) => {
        if (dispatch.form === "lua") {
            await lua(luaArg)
            return
        }
        if (dispatch.form === "legacy") {
            await legacy(legacyArgv)
            return
        }
        try {
            await lua(luaArg)
            dispatch.form = "lua"
        } catch {
            // Both forms failing is a real error and must propagate —
            // the caller logs it. Only a Lua rejection followed by a
            // legacy success means "old Hyprland", and nothing else
            // should be inferred from one failed dispatch.
            await legacy(legacyArgv)
            dispatch.form = "legacy"
            warn("hyprctl: this Hyprland predates the Lua dispatch grammar, using the legacy form")
        }
    }) as Dispatcher
    dispatch.form = null
    return dispatch
}

export const hyprDispatch = createDispatcher(execAsync, m => console.warn(m))
