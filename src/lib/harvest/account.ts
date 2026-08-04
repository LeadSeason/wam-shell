// account mode, fetched at startup (403 = not an admin -> defaults).
// A plain holder, not gnim state: read synchronously by the formatting
// and request-building helpers, written once from the /company reply
export const accountMode = {
    wantsTimestampTimers: false,
    accountClock: "12h" as "12h" | "24h",
    timeFormat: "hours_minutes" as "decimal" | "hours_minutes",
}
