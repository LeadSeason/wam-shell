import { test, eq } from "./framework"
import AstalNotifd from "gi://AstalNotifd?version=0.1"
import { capPopups, popupDuration, PopupEntry } from "../src/lib/notifd"

const entry = (key: string, critical = false): PopupEntry => ({
    key,
    desktop: null,
    item: null,
    critical,
})

const keys = (l: PopupEntry[]) => l.map(p => p.key)

test("capPopups: under the cap, nothing moves", () => {
    const l = [entry("a"), entry("b")]
    eq(keys(capPopups(l, 4)), ["a", "b"])
    eq(keys(capPopups(l, 2)), ["a", "b"])
})

test("capPopups: over the cap, the oldest ordinary banner goes", () => {
    const l = [entry("a"), entry("b"), entry("c")]
    eq(keys(capPopups(l, 2)), ["b", "c"])
})

test("capPopups: a critical is never evicted while an ordinary one remains", () => {
    // the critical is the OLDEST — a plain slice would drop exactly it
    const l = [entry("urgent", true), entry("b"), entry("c")]
    eq(keys(capPopups(l, 2)), ["urgent", "c"])
})

test("capPopups: several criticals all survive a burst", () => {
    const l = [entry("u1", true), entry("u2", true), entry("b"), entry("c"), entry("d")]
    eq(keys(capPopups(l, 3)), ["u1", "u2", "d"])
})

test("capPopups: an all-critical stack still falls back to the oldest", () => {
    // something has to give when there is nothing ordinary to sacrifice
    const l = [entry("u1", true), entry("u2", true), entry("u3", true)]
    eq(keys(capPopups(l, 2)), ["u2", "u3"])
})

test("capPopups: does not mutate its input", () => {
    const l = [entry("a"), entry("b"), entry("c")]
    capPopups(l, 1)
    eq(keys(l), ["a", "b", "c"])
})

test("popupDuration: the sender's expire_timeout wins", () => {
    // spec: >0 is a request in milliseconds, and it beats our default
    eq(popupDuration(20_000, null, 5000), 20_000)
    eq(popupDuration(20_000, AstalNotifd.Urgency.LOW, 5000), 20_000)
    // 0 means "leave it up", even for an otherwise ordinary notification
    eq(popupDuration(0, AstalNotifd.Urgency.NORMAL, 5000), 0)
})

test("popupDuration: -1 defers to the configured default", () => {
    eq(popupDuration(-1, AstalNotifd.Urgency.NORMAL, 5000), 5000)
    eq(popupDuration(-1, null, 5000), 5000)
    // low drains twice as fast, critical does not drain at all
    eq(popupDuration(-1, AstalNotifd.Urgency.LOW, 5000), 2500)
    eq(popupDuration(-1, AstalNotifd.Urgency.CRITICAL, 5000), 0)
})

test("popupDuration: a critical sender can still ask for a length", () => {
    // urgency only decides when the sender did not; asking for 10s means
    // 10s, not "critical so forever"
    eq(popupDuration(10_000, AstalNotifd.Urgency.CRITICAL, 5000), 10_000)
})
