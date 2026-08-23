// Turning a bluez D-Bus error into something worth showing a person.
//
// Its own module, with no imports: `lib/bluetoothCtl.ts` cannot be
// pulled into a test — it reaches AstalBluetooth, which opens the system
// bus at import — and this mapping is the part of it that is worth
// checking. See tests/bluetooth.test.ts.

/**
 * The bluez error NAME out of a GDBus error message:
 * `"GDBus.Error:org.bluez.Error.AlreadyExists: …"` -> `"AlreadyExists"`.
 *
 * `""` for anything that is not a bluez error — a GDBus reply timeout,
 * a dropped connection, or a thrown value that is not an Error at all.
 */
export function bluezErrorName(e: unknown): string {
    return (e as Error)?.message?.match(/org\.bluez\.Error\.(\w+)/)?.[1] ?? ""
}

// bluez's error names are accurate but not user-facing ("NotReady" for
// an adapter that is still powering on). Only the ones a person can act
// on get their own wording; everything else falls back to the caller's
// summary, which at least says which operation failed
const ERROR_TEXT: Record<string, string> = {
    AuthenticationFailed: "Wrong PIN or passkey",
    AuthenticationRejected: "Rejected by the device",
    AuthenticationCanceled: "Pairing cancelled",
    AuthenticationTimeout: "The device stopped responding",
    ConnectionAttemptFailed: "The device did not respond",
    NotReady: "Bluetooth is not ready yet",
    Blocked: "Blocked by rfkill",
    NotAvailable: "The device is out of range",
    InProgress: "Already in progress",
}

/** short, user-facing text for a failed bluez call */
export function bluezErrorText(e: unknown, fallback: string): string {
    const name = bluezErrorName(e)
    if (name) return ERROR_TEXT[name] ?? fallback
    // GDBus's own timeout. Every call the shell makes sets one long
    // enough that bluez would have answered by now, so this means it
    // never did — not that the operation was slow
    if ((e as Error)?.message?.includes("Timeout")) return "Timed out"
    return fallback
}
