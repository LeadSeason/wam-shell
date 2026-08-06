import { test, eq } from "./framework"
import AstalNotifd from "gi://AstalNotifd?version=0.1"
import { capPopups, groupPopups, popupDuration, PopupEntry } from "../src/lib/notifd"

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

// ---------------------------------------------------------- groupPopups

const named = (key: string, appName: string, critical = false): PopupEntry => ({
    key,
    desktop: null,
    // groupPopups reads the app name off whichever half is present; a
    // provider item is the half that needs no GDK display to build
    item: { appName } as any,
    critical,
})

const shape = (l: PopupEntry[]) =>
    groupPopups(l).map(g => `${g.entries[0].key}x${g.entries.length}`)

test("groupPopups: one banner, one group", () => {
    eq(shape([named("a", "Syncthing")]), ["ax1"])
})

test("groupPopups: same app folds, first stays the representative", () => {
    // the caller passes newest first, so entries[0] is the newest and is
    // what the card shows
    const groups = groupPopups([
        named("new", "Syncthing"),
        named("mid", "Syncthing"),
        named("old", "Syncthing"),
    ])
    eq(groups.length, 1)
    eq(groups[0].entries.map(e => e.key), ["new", "mid", "old"])
    eq(groups[0].key, "new")
})

test("groupPopups: different apps stay apart", () => {
    eq(shape([named("a", "Syncthing"), named("b", "Signal")]), ["ax1", "bx1"])
})

test("groupPopups: folding is by app, not adjacency", () => {
    // unlike the center's feed (which only folds CONSECUTIVE runs), a
    // banner stack is small and live: two arrivals from one app belong
    // on one card even with another app's banner between them
    eq(shape([named("a", "CI"), named("b", "Signal"), named("c", "CI")]), ["ax2", "bx1"])
})

test("groupPopups: app names fold case-insensitively", () => {
    eq(shape([named("a", "Syncthing"), named("b", "syncthing")]), ["ax2"])
})

test("groupPopups: criticals never merge, and lead", () => {
    // two criticals from ONE app stay two cards: folding one away would
    // hide a headline that never expires behind whichever arrived last
    const groups = shape([
        named("ord", "Backup"),
        named("u1", "Backup", true),
        named("u2", "Backup", true),
    ])
    eq(groups, ["u1x1", "u2x1", "ordx1"])
})

test("groupPopups: a critical does not absorb its app's ordinary banners", () => {
    eq(shape([named("u", "Backup", true), named("a", "Backup"), named("b", "Backup")]), [
        "ux1",
        "ax2",
    ])
})

test("groupPopups: anonymous senders are never folded together", () => {
    // an empty app name is not an app: folding on it would merge
    // unrelated senders into one misleading count
    eq(shape([named("a", ""), named("b", "")]), ["ax1", "bx1"])
})

test("groupPopups: empty in, empty out", () => {
    eq(groupPopups([]), [])
})
