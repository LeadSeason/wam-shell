// Policy for the daemon-name watchdog's exit decision (#357): a shell
// that owns neither its bus names nor anything else is the worst
// failure mode this codebase has — the process runs, the windows draw,
// and every notify-send dies silently for the whole session. Astal
// acquires org.freedesktop.Notifications inside the library and offers
// no re-claim, so an UNOWNED name cannot heal from inside the process;
// the only recovery is a restart. The watchdog in notifd.ts feeds each
// ownership reading to the guard and quits on "exit", letting the
// systemd service (Restart=always) bring the shell back.
//
// GTK-free like popupStack and ClickPacer, so the unit suite can pin
// the truth table without a bus.

export type NameOwnership = "pending" | "ours" | "foreign" | "unowned"
export type UnownedVerdict = "watch" | "exit"

export class UnownedNameGuard {
    private unownedTicks = 0

    constructor(
        /** [notifications].daemon === "wam-shell". In auto/system modes
         *  the name may belong to another daemon BY DESIGN, and a
         *  restart cannot claim what a living peer holds. */
        private readonly forcedDaemon: boolean,
        /** [notifications].exit_if_unowned — the kill switch. */
        private readonly exitIfUnowned: boolean,
    ) {}

    /** Feed one ownership reading, oldest first. "exit" quits the app
     *  so the service restarts the shell; "watch" keeps the current
     *  warn-only behavior. */
    tick(state: NameOwnership): UnownedVerdict {
        if (state === "unowned") this.unownedTicks++
        else this.unownedTicks = 0
        if (!this.exitIfUnowned || !this.forcedDaemon) return "watch"
        // one reading is not a verdict: the settle tick can catch the
        // claim mid-landing, or a bus busy with a handover. A SECOND
        // unowned reading a full watch interval later — the name was
        // never claimed, or its owner died without a successor — is
        // the half-dead start, and nothing inside this process can
        // fix it.
        return this.unownedTicks >= 2 ? "exit" : "watch"
    }
}
