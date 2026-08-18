import { Astal, Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import Graphene from "gi://Graphene?version=1.0"
import AstalNotifd from "gi://AstalNotifd?version=0.1"
import Pango from "gi://Pango?version=1.0"
import app from "ags/gtk4/app"
import { Accessor, For, createComputed, createRoot, createState } from "gnim"
import {
    LOCAL_SOURCE,
    count,
    dnd,
    mutedApps,
    mutedProviders,
    persistent,
    toggleAppMute,
    toggleDnd,
    toggleProviderMute,
} from "../../lib/notifd"
import CommandRegistry from "../../lib/requestHandler"
import { idleAdd, timeoutAdd, sourceRemove } from "../../lib/metrics"
import { hideOnFocusLoss } from "../../lib/popupFocus"
import { closeOtherPopups, registerPopup } from "../../lib/exclusivePopups"
import { acquireClock, nowSec, relTime } from "../../lib/relTime"
import { providers } from "../../lib/notificationProviders"
import type { ProviderItem } from "../../lib/notificationProviders"
import CenterRow from "./CenterRow"
import { appIconFor, fromDesktop, fromItem } from "./rowData"
import { buildFeed, compareRows, FeedBlock } from "./feed"
import { PaneEmpty } from "../PaneEmpty"

const registry = CommandRegistry.get_default()

// the request is registered eagerly (import side effect), but the
// window is built lazily on first toggle — no need to construct it
// at shell startup
let win: Astal.Window | null = null
let rev: Gtk.Revealer | null = null
let card: Gtk.Box | null = null
let searchEntry: Gtk.Entry | null = null
let hideSource: number | null = null
// the idle that focuses the search entry once its revealer has expanded.
// Tracked like hideSource: an untracked deferred source runs against a
// window that may have been hidden in the meantime, and there is nothing
// left to cancel it with
let focusSearchSource: number | null = null
// the shared relative-time clock, held only while the center is open:
// rows show ages that keep counting up, and nothing should tick for a
// window nobody is looking at
let releaseClock: (() => void) | null = null

// Registered at module scope, guarded on visibility: the window is
// built lazily, and every other popup opening calls this whether or not
// the center is up.
//
// Missing this call is why exclusion only worked one way — the center
// closed the quick settings, but opening the quick settings could not
// close the center, because nothing had ever registered it.
registerPopup("notifications", () => {
    if (win?.is_visible()) hide()
})

function show() {
    // the other corner-owning popups: only one of them can usefully be
    // on screen at a time
    closeOtherPopups("notifications")
    if (hideSource !== null) {
        sourceRemove(hideSource)
        hideSource = null
    }
    // stale-while-revalidate provider inboxes on open (age-gated)
    for (const p of providers) p.refresh()
    if (!releaseClock) releaseClock = acquireClock()
    win!.present()
    rev!.revealChild = true
}

function hide() {
    // the next open starts with an empty search: reset the state AND
    // the entry's text (they're separate — one doesn't follow the other)
    setQuery("")
    searchEntry?.set_text("")
    setSearchOpen(false)
    // the search field is going away with the window: nothing left to focus
    if (focusSearchSource !== null) {
        sourceRemove(focusSearchSource)
        focusSearchSource = null
    }
    rev!.revealChild = false
    // let go of the clock now, not when the slide-out finishes: ages do
    // not need to keep ticking through a 200ms fade nobody is reading,
    // and releasing it from the delayed callback meant a reopen within
    // that window cancelled the release entirely — leaving the timer
    // running against a closed window until the next full close
    releaseClock?.()
    releaseClock = null
    if (hideSource !== null) sourceRemove(hideSource)
    hideSource = timeoutAdd("notifCenter:hide", GLib.PRIORITY_DEFAULT, 200, () => {
        hideSource = null
        win!.hide()
        return GLib.SOURCE_REMOVE
    })
}

registry.register({
    name: ["notifications", "notificationCenter"],
    description: "Toggle the notification center",
    main: () => {
        ensureWindow()
        if (win!.is_visible()) {
            hide()
            return "hidden"
        }
        show()
        return "shown"
    },
})

// flat list of the center's history (transient-hinted and filtered apps
// excluded), newest first (ties broken by id: notifications sent within
// the same second still order by arrival)
const sorted = persistent.as(list => [...list].sort((a, b) => b.time - a.time || b.id - a.id))

// header filter: case-insensitive substring match on the app name.
// createComputed over both inputs: sorted.as alone would not recompute
// when the query changes
const [query, setQuery] = createState("")
// the search field is folded away until asked for. It used to be the
// widest, tallest thing in the window and the first thing the eye
// landed on — chrome for a job you do occasionally, sitting above the
// content you came for every time
const [searchOpen, setSearchOpen] = createState(false)

// provider integrations (GitHub & co.): their items merge into the
// list; a header icon per provider filters to just its items
const [providerFilter, setProviderFilter] = createState<string | null>(null)
// special filter value: only the local daemon's notifications. Shared
// with the mute list, so the chip's filter and its mute cannot drift
// apart into two different spellings of "local"
const LOCAL_FILTER = LOCAL_SOURCE

interface Row {
    key: string
    time: number
    appName: string
    iconName: string
    // provider rows from a `soonestFirst` provider (calendar): the
    // merged sort lists them next-event-first above the rest (feed.ts)
    soonestFirst?: boolean
    desktop: AstalNotifd.Notification | null
    item: ProviderItem | null
}

// Someone is waiting on you, as opposed to telling you something. The
// center lifts these above the feed, because a task that is due and a
// "connection established" are not the same kind of object and a purely
// chronological list insists that they are.
//
// Critical is the desktop spec's own word for it. For provider items
// only the provider can tell — a pull request you opened and one you
// were asked to review look identical from out here — so it says so.
function isNeeded(r: Row): boolean {
    if (r.desktop) return r.desktop.urgency === AstalNotifd.Urgency.CRITICAL
    return !!r.item?.actionable
}

/**
 * A provider row's identity for gnim's `For` — id plus everything the
 * card renders, so an edited item is rebuilt rather than reused stale.
 *
 * The action LABELS rather than their ids: the id is fixed ("postpone")
 * where the label carries the value that changed ("Postpone 30m").
 */
function providerRowKey(item: ProviderItem): string {
    const actions = (item.actions ?? []).map(a => a.label).join(",")
    return [
        "provider",
        item.id,
        item.imagePath ?? "",
        item.time,
        item.summary,
        item.body,
        item.iconName,
        item.actionable ? "1" : "0",
        actions,
    ].join("\0")
}

// built inside ensureWindow, NOT at module scope: app.tsx imports this
// module before the provider modules, so the registry is still empty
// here — the deps spread must be evaluated when the lazy window is
// built, by which time every provider has registered
function buildMerged() {
    // sources: desktop list, one items accessor per provider, the two
    // filters. Values arrive in the same order
    return createComputed(
        [sorted, ...providers.map(p => p.items), providerFilter, query],
        (...vals) => {
            const desktop = vals[0] as AstalNotifd.Notification[]
            const pFilter = vals[vals.length - 2] as string | null
            const q = vals[vals.length - 1] as string
            const rows: Row[] = []
            // a filter replaces the view entirely: a provider's own
            // items, or just the local daemon's for the local filter
            if (!pFilter || pFilter === LOCAL_FILTER) {
                for (const n of desktop) {
                    // the time is part of the key: replaces_id makes the
                    // daemon emit a NEW Notification object with the same
                    // id but a new time, and gnim's For would otherwise
                    // reuse the stale row (it reads state once at build)
                    rows.push({
                        key: `desktop:${n.id}:${n.time}`,
                        time: n.time,
                        appName: n.appName || "unknown",
                        // resolved, not the raw hint: apps often send no
                        // app_icon at all, and a folded group headed by
                        // the generic fallback next to rows that resolved
                        // theirs fine looked like two different apps
                        iconName: appIconFor(n.appIcon, n.appName),
                        desktop: n,
                        item: null,
                    })
                }
            }
            providers.forEach((p, i) => {
                if (pFilter && p.name !== pFilter) return
                for (const item of vals[1 + i] as ProviderItem[]) {
                    rows.push({
                        // The key covers everything the row DRAWS, not
                        // just the item's identity.
                        //
                        // gnim's For reuses a child whose key did not
                        // change and never re-invokes the factory, and
                        // CenterRow reads its RowData once at
                        // construction. The thumbnail was already part of
                        // this for that reason (art landing after the row
                        // was built has to force a rebuild) — but so is
                        // every other mutable field, and they were not: a
                        // Todoist task whose due time moved kept its old
                        // "Today · 14:00" body and its stale Postpone
                        // button, and a GitHub thread whose reason
                        // changed kept reading "Review requested"
                        key: providerRowKey(item),
                        time: item.time,
                        appName: item.appName,
                        iconName: item.iconName,
                        soonestFirst: p.soonestFirst,
                        desktop: null,
                        item,
                    })
                }
            })
            const needle = q.trim().toLowerCase()
            const filteredRows =
                needle === "" ? rows : rows.filter(r => r.appName.toLowerCase().includes(needle))
            return filteredRows.sort(compareRows)
        },
    )
}
let merged: Accessor<Row[]>
let needsYou: Accessor<Row[]>
let feedBlocks: Accessor<FeedBlock<Row>[]>

function buildFeedBlocks(rows: Accessor<Row[]>): Accessor<FeedBlock<Row>[]> {
    // the day dividers depend on the clock as much as on the rows: a
    // list left open past midnight has to relabel itself
    return createComputed([rows, nowSec], (list, now) =>
        buildFeed(
            list.filter(r => !isNeeded(r)),
            now,
        ),
    )
}

// providers behind an interactive sign-in (YouTube): when their filter
// is selected and they have no accounts yet, the empty state offers
// the sign-in button. Static fallback accessor for providers without
// one — deps are evaluated at window build, when the registry is final
const [FALSE] = createState(false)

function buildSignInTarget() {
    return createComputed(
        [providerFilter, ...providers.map(p => p.signInVisible ?? FALSE)],
        (filter, ...visibles) => {
            if (!filter) return null
            const i = providers.findIndex(p => p.name === filter)
            if (i < 0) return null
            const p = providers[i]
            return p.signIn && visibles[i] ? p : null
        },
    )
}
let signInTarget: ReturnType<typeof buildSignInTarget>

// the clear-all button's enabled state: a source must be picked AND
// hold items. Deps are evaluated at window build (registry final)
function buildClearable() {
    return createComputed(
        [providerFilter, count, ...providers.map(p => p.items)],
        (f, localCount, ...itemLists) => {
            if (!f) return false
            if (f === LOCAL_FILTER) return localCount > 0
            const i = providers.findIndex(p => p.name === f)
            return i >= 0 && ((itemLists[i] as ProviderItem[] | undefined)?.length ?? 0) > 0
        },
    )
}
let clearable: ReturnType<typeof buildClearable>

// the picked provider's sync problem ("quota exceeded"), null when
// healthy — replaces the misleading "No notifications" in the empty
// state. Static fallback accessor for providers without status
const [NULL_STR] = createState<string | null>(null)

function buildProviderStatus() {
    return createComputed(
        [providerFilter, ...providers.map(p => p.status ?? NULL_STR)],
        (filter, ...statuses) => {
            if (!filter) return null
            const i = providers.findIndex(p => p.name === filter)
            return i >= 0 ? (statuses[i] as string | null) : null
        },
    )
}
let providerStatus: ReturnType<typeof buildProviderStatus>

function onKey(_e: Gtk.EventControllerKey, keyValue: number) {
    if (keyValue === Gdk.KEY_Escape) hide()
}

function onClick(_e: Gtk.GestureClick, _: number, x: number, y: number) {
    // the overlay is fullscreen; only clicks outside the card close it
    const [, rect] = card!.compute_bounds(win!)
    if (!rect.contains_point(new Graphene.Point({ x, y }))) hide()
}

// Provider callbacks are app code running inside GTK's gesture dispatch:
// a throwing activate/dismiss/hide/run must not escape into the event
// machinery, so they are guarded the way lib/notify guards its own
// action handlers
function guarded<A extends unknown[]>(call: (...args: A) => void): (...args: A) => void {
    return (...args) => {
        try {
            call(...args)
        } catch (e) {
            console.warn("notifications: provider callback failed:", e)
        }
    }
}

/** One row, wired to whichever kind of notification produced it. The
 *  gestures differ on purpose: dismissing a desktop notification
 *  destroys it, where a provider item has both a "not now" (hide, right
 *  click) and a "done" (the provider's own semantics). */
function ItemRow({ row }: { row: Row }) {
    if (row.desktop) {
        const n = row.desktop
        const hasDefault = n.get_actions().some(a => a.get_id() === "default")
        return (
            <CenterRow
                data={fromDesktop(n)}
                dismissLabel="Dismiss"
                onActivate={() => {
                    if (hasDefault) n.invoke("default")
                }}
                onDismiss={() => n.dismiss()}
                onAction={id => n.invoke(id)}
                onMuteApp={() => toggleAppMute(n.appName)}
                appMuted={mutedApps.as(list =>
                    list.includes((n.appName || "unknown").toLowerCase()),
                )}
            />
        )
    }
    const item = row.item!
    return (
        <CenterRow
            data={fromItem(item)}
            dismissLabel="Mark done"
            onActivate={guarded(() => item.activate())}
            onDismiss={guarded(() => item.dismiss())}
            onSecondary={guarded(() => item.hide())}
            onAction={guarded(id => item.actions?.find(a => a.id === id)?.run())}
        />
    )
}

/** Dismiss one row for real — destroy the notification, or mark the
 *  provider item done. Not the same as taking a banner off screen. */
function dismissRow(r: Row) {
    if (r.desktop) r.desktop.dismiss()
    else guarded(() => r.item!.dismiss())()
}

/** A run of notifications from one app, folded behind a single line
 *  until asked for. Its open state is local: gnim's For rebuilds a group
 *  when its key changes, and a group whose rows changed is a different
 *  group — reopening it is the honest default. */
function FeedGroup({ block }: { block: Extract<FeedBlock<Row>, { kind: "group" }> }) {
    if (block.rows.length === 1) return <ItemRow row={block.rows[0]} />

    // the group's rows all come from one app and mirror or don't as a
    // set, so the header and the rule down the side follow the first of
    // them rather than being decided separately
    const head = block.rows[0]
    const rtl = (head.desktop ? fromDesktop(head.desktop) : fromItem(head.item!)).rtl

    const [open, setOpen] = createState(false)
    return (
        <box
            $={self => {
                if (rtl) self.set_direction(Gtk.TextDirection.RTL)
            }}
            cssClasses={["group"]}
            orientation={Gtk.Orientation.VERTICAL}
        >
            <button
                cssClasses={["groupHead"]}
                tooltipText={`${block.rows.length} from ${block.appName} — middle-click to clear them all`}
                onClicked={() => setOpen(!open.get())}
            >
                {/* middle click clears the whole run, matching what it
                does on a single row. A folded group is exactly the case
                where clearing one at a time is tedious, and the count is
                right there to say how many are going */}
                <Gtk.GestureClick button={2} onReleased={() => block.rows.forEach(dismissRow)} />
                <box spacing={8}>
                    <image iconName={block.iconName} pixelSize={16} />
                    <label
                        cssClasses={["appName"]}
                        label={block.appName}
                        xalign={0}
                        maxWidthChars={22}
                        ellipsize={Pango.EllipsizeMode.END}
                    />
                    <label cssClasses={["count"]} label={String(block.rows.length)} />
                    <label hexpand />
                    {/* the newest of the folded rows: a group is worth
                    skipping past when it is old, and without this the
                    fold hides the one thing that says so */}
                    <label
                        cssClasses={["time"]}
                        label={nowSec.as(n => relTime(block.rows[0].time, n))}
                    />
                    <image
                        cssClasses={["chevron"]}
                        iconName={open.as(o => (o ? "pan-up-symbolic" : "pan-down-symbolic"))}
                    />
                </box>
            </button>
            <revealer
                revealChild={open}
                transitionDuration={150}
                transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
            >
                <box
                    $={self => {
                        // set on THIS box, not the group: marginStart is
                        // resolved against the widget's own direction,
                        // and gtk does not push an explicitly set
                        // direction down to children that never had one
                        if (rtl) self.set_direction(Gtk.TextDirection.RTL)
                    }}
                    cssClasses={rtl ? ["groupRows", "rtl"] : ["groupRows"]}
                    orientation={Gtk.Orientation.VERTICAL}
                    // marginStart follows the text direction; the rule
                    // down the side cannot, so it switches sides via the
                    // rtl class instead
                    marginStart={10}
                >
                    {block.rows.map(r => (
                        <ItemRow row={r} />
                    ))}
                </box>
            </revealer>
        </box>
    )
}

function ensureWindow() {
    if (win) return
    const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor
    createRoot(() => {
        merged = buildMerged()
        needsYou = merged.as(rows => rows.filter(isNeeded))
        feedBlocks = buildFeedBlocks(merged)
        signInTarget = buildSignInTarget()
        clearable = buildClearable()
        providerStatus = buildProviderStatus()
        app.add_window(
            (
                <window
                    $={self => {
                        win = self
                        hideOnFocusLoss(win, hide)
                    }}
                    name="Notifications"
                    class="Notifications"
                    namespace="notifications"
                    // fullscreen overlay (QSettings/harvest pattern): an
                    // edge-anchored window grows with the list but never
                    // shrinks back — the card inside clamps to content
                    anchor={TOP | BOTTOM | LEFT | RIGHT}
                    // ON_DEMAND, not EXCLUSIVE: the grab stole input from
                    // other surfaces; focus loss closes instead
                    keymode={Astal.Keymode.ON_DEMAND}
                    visible={false}
                >
                    <Gtk.EventControllerKey onKeyPressed={onKey} />
                    <Gtk.GestureClick onPressed={onClick} />
                    <box halign={Gtk.Align.END} valign={Gtk.Align.START}>
                        <revealer
                            $={self => {
                                rev = self
                            }}
                            transitionDuration={200}
                            transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
                        >
                            <box
                                $={self => {
                                    card = self
                                }}
                                cssClasses={["notifications"]}
                                orientation={Gtk.Orientation.VERTICAL}
                                widthRequest={440}
                                marginTop={30}
                                marginEnd={12}
                            >
                                {/* one row of chrome: what this window
                                is, and the two things you do to all of
                                it at once */}
                                <box cssClasses={["header"]} spacing={6}>
                                    <label
                                        cssClasses={["windowTitle"]}
                                        label="Notifications"
                                        xalign={0}
                                        hexpand
                                    />
                                    {/* Search lives in the WINDOW's chrome,
                                    not in the feed's.

                                    It used to sit in the Feed zone header,
                                    which is inside the scroller that is
                                    hidden when the list is empty — so a
                                    query matching nothing hid the field
                                    holding it, along with the toggle that
                                    would clear it. The "No matches" state
                                    appeared with no way back except
                                    Escape, which closes the whole window.
                                    A control that filters a list cannot
                                    live inside that list. */}
                                    <button
                                        cssClasses={searchOpen.as(o =>
                                            o ? ["search", "active"] : ["search"],
                                        )}
                                        tooltipText="Filter by app"
                                        onClicked={() => {
                                            const next = !searchOpen.get()
                                            setSearchOpen(next)
                                            if (!next) {
                                                // closing it must also drop the
                                                // filter, or the list stays
                                                // narrowed by a field nobody
                                                // can see
                                                setQuery("")
                                                searchEntry?.set_text("")
                                                return
                                            }
                                            // the entry lives inside a revealer
                                            // that has not expanded yet, and an
                                            // unmapped widget cannot take focus
                                            focusSearchSource = idleAdd(
                                                "notifCenter:focusSearch",
                                                GLib.PRIORITY_DEFAULT_IDLE,
                                                () => {
                                                    focusSearchSource = null
                                                    searchEntry?.grab_focus()
                                                    return GLib.SOURCE_REMOVE
                                                },
                                            )
                                        }}
                                    >
                                        <image iconName="system-search-symbolic" />
                                    </button>
                                    <button
                                        tooltipText="Do not disturb"
                                        cssClasses={dnd.as(v => (v ? ["active"] : []))}
                                        onClicked={() => toggleDnd()}
                                    >
                                        <image
                                            iconName={dnd.as(v =>
                                                v
                                                    ? "notifications-disabled-symbolic"
                                                    : "preferences-system-notifications-symbolic",
                                            )}
                                        />
                                    </button>
                                    {/* clears only the active filter's
                                    items (local: the daemon's; a
                                    provider: its items' own dismiss) —
                                    always visible, enabled only when
                                    the picked source holds items */}
                                    <button
                                        sensitive={clearable}
                                        tooltipText={providerFilter.as(f =>
                                            f === LOCAL_FILTER
                                                ? "Clear all local notifications"
                                                : f
                                                  ? `Clear all ${f} notifications`
                                                  : "Pick a source to clear",
                                        )}
                                        onClicked={() => {
                                            const f = providerFilter.get()
                                            if (f === LOCAL_FILTER) {
                                                // the history list, not the
                                                // daemon's: transient
                                                // notifications the centre
                                                // never showed are not ours
                                                // to clear
                                                for (const n of [...persistent.get()]) n.dismiss()
                                            } else if (f) {
                                                const p = providers.find(x => x.name === f)
                                                for (const item of [...(p?.items.get() ?? [])])
                                                    guarded(() => item.dismiss())()
                                            }
                                        }}
                                    >
                                        <image iconName="user-trash-symbolic" />
                                    </button>
                                </box>
                                {/* local + provider filter chips: click
                                to show only that source, again to go
                                back. Static by window-build time — plain
                                map, no reactivity needed. Right-click a
                                provider to mute/unmute its banners */}
                                <box cssClasses={["filtersRow"]} spacing={6}>
                                    <button
                                        cssClasses={createComputed(
                                            [providerFilter, mutedProviders],
                                            (f, m) => [
                                                "provider",
                                                ...(f === LOCAL_FILTER ? ["active"] : []),
                                                ...(m.includes(LOCAL_FILTER) ? ["muted"] : []),
                                            ],
                                        )}
                                        tooltipText={mutedProviders.as(m =>
                                            m.includes(LOCAL_FILTER)
                                                ? "Show only local notifications (right-click to unmute)"
                                                : "Show only local notifications (right-click to mute banners)",
                                        )}
                                        onClicked={() =>
                                            setProviderFilter(
                                                providerFilter.get() === LOCAL_FILTER
                                                    ? null
                                                    : LOCAL_FILTER,
                                            )
                                        }
                                    >
                                        {/* the desktop's own notifications are a
                                        source like any other: same right-click
                                        mute as the providers, rather than DND
                                        being the only way to quieten them */}
                                        <Gtk.GestureClick
                                            button={3}
                                            onReleased={() => toggleProviderMute(LOCAL_FILTER)}
                                        />
                                        <box spacing={4}>
                                            <image iconName="computer-symbolic" />
                                            {/* pending count, hidden at 0 */}
                                            <label
                                                cssClasses={["count"]}
                                                label={count.as(n => (n > 0 ? String(n) : ""))}
                                            />
                                            <image
                                                cssClasses={["mutedBadge"]}
                                                iconName="notifications-disabled-symbolic"
                                                pixelSize={12}
                                                visible={mutedProviders.as(m =>
                                                    m.includes(LOCAL_FILTER),
                                                )}
                                            />
                                        </box>
                                    </button>
                                    {providers.map(p => (
                                        <button
                                            cssClasses={createComputed(
                                                [providerFilter, mutedProviders],
                                                (f, m) => [
                                                    "provider",
                                                    ...(f === p.name ? ["active"] : []),
                                                    ...(m.includes(p.name) ? ["muted"] : []),
                                                ],
                                            )}
                                            tooltipText={mutedProviders.as(m =>
                                                m.includes(p.name)
                                                    ? `Show only ${p.name} notifications (right-click to unmute)`
                                                    : `Show only ${p.name} notifications (right-click to mute banners)`,
                                            )}
                                            onClicked={() =>
                                                setProviderFilter(
                                                    providerFilter.get() === p.name ? null : p.name,
                                                )
                                            }
                                        >
                                            <Gtk.GestureClick
                                                button={3}
                                                onReleased={() => toggleProviderMute(p.name)}
                                            />
                                            <box spacing={4}>
                                                <image iconName={p.iconName} />
                                                <label
                                                    cssClasses={["count"]}
                                                    label={p.items.as(l =>
                                                        l.length > 0 ? String(l.length) : "",
                                                    )}
                                                />
                                                {/* visible mute marker */}
                                                <image
                                                    cssClasses={["mutedBadge"]}
                                                    iconName="notifications-disabled-symbolic"
                                                    pixelSize={12}
                                                    visible={mutedProviders.as(m =>
                                                        m.includes(p.name),
                                                    )}
                                                />
                                            </box>
                                        </button>
                                    ))}
                                </box>
                                {/* the field the header button reveals —
                                at card level, so it survives its own
                                no-match query */}
                                <revealer
                                    revealChild={searchOpen}
                                    transitionDuration={150}
                                    transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
                                >
                                    <entry
                                        $={self => {
                                            searchEntry = self
                                        }}
                                        cssClasses={["filter", "textInput"]}
                                        placeholderText="Filter by app…"
                                        hexpand
                                        onChanged={self => setQuery(self.text)}
                                    />
                                </revealer>
                                {/* fixed-height body: switching between
                                an empty source and a full one must not
                                resize the card. Empty sources fill the
                                middle with a centered state instead */}
                                <box orientation={Gtk.Orientation.VERTICAL} heightRequest={640}>
                                    <box visible={merged.as(l => l.length === 0)} vexpand>
                                        {/* an enabled-but-unconfigured
                                        provider gets setup instructions
                                        when its filter is picked */}
                                        <box
                                            visible={providerFilter.as(f => {
                                                const p = providers.find(x => x.name === f)
                                                return !!p?.setupHint
                                            })}
                                            vexpand
                                        >
                                            <PaneEmpty
                                                icon={providerFilter.as(
                                                    f =>
                                                        providers.find(x => x.name === f)
                                                            ?.iconName ?? "dialog-warning-symbolic",
                                                )}
                                                title={providerFilter.as(f => {
                                                    const p = providers.find(x => x.name === f)
                                                    return `Set up ${p?.displayName ?? p?.name ?? ""}`
                                                })}
                                                hint={providerFilter.as(
                                                    f =>
                                                        providers.find(x => x.name === f)
                                                            ?.setupHint ?? "",
                                                )}
                                            />
                                        </box>
                                        {/* a failing provider explains
                                        itself instead of pretending the
                                        inbox is empty */}
                                        <box
                                            visible={createComputed(
                                                [providerStatus, providerFilter],
                                                (s, f) =>
                                                    s !== null &&
                                                    !providers.find(x => x.name === f)?.setupHint,
                                            )}
                                            vexpand
                                        >
                                            <PaneEmpty
                                                icon="dialog-warning-symbolic"
                                                title={providerStatus.as(s => s ?? "")}
                                                hint=""
                                                titleClasses={["status"]}
                                            />
                                        </box>
                                        {/* interactive sign-in offer
                                        (YouTube) when the picked
                                        provider has no accounts yet */}
                                        <box
                                            visible={createComputed(
                                                [providerStatus, signInTarget],
                                                (s, t) => s === null && t !== null,
                                            )}
                                            vexpand
                                        >
                                            <PaneEmpty
                                                icon={signInTarget.as(
                                                    t => t?.iconName ?? "mail-inbox-symbolic",
                                                )}
                                                title="No notifications"
                                                hint=""
                                                child={
                                                    <button
                                                        cssClasses={["providerSignin"]}
                                                        halign={Gtk.Align.CENTER}
                                                        onClicked={() =>
                                                            signInTarget.get()?.signIn?.()
                                                        }
                                                    >
                                                        <label
                                                            label={signInTarget.as(
                                                                t =>
                                                                    `Sign in to ${t?.displayName ?? t?.name ?? ""}`,
                                                            )}
                                                        />
                                                    </button>
                                                }
                                            />
                                        </box>
                                        {/* plain empty inbox, or no
                                        matches for the search */}
                                        <box
                                            visible={createComputed(
                                                [providerStatus, signInTarget, providerFilter],
                                                (s, t, f) =>
                                                    s === null &&
                                                    t === null &&
                                                    !providers.find(x => x.name === f)?.setupHint,
                                            )}
                                            vexpand
                                        >
                                            <PaneEmpty
                                                icon={query.as(q =>
                                                    q.trim() === ""
                                                        ? "mail-inbox-symbolic"
                                                        : "system-search-symbolic",
                                                )}
                                                title={query.as(q =>
                                                    q.trim() === ""
                                                        ? "No notifications"
                                                        : "No matches",
                                                )}
                                                hint=""
                                            />
                                        </box>
                                    </box>
                                    <Gtk.ScrolledWindow
                                        vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
                                        hscrollbarPolicy={Gtk.PolicyType.NEVER}
                                        vexpand
                                        visible={merged.as(l => l.length > 0)}
                                    >
                                        <box
                                            cssClasses={["list"]}
                                            orientation={Gtk.Orientation.VERTICAL}
                                        >
                                            {/* what is waiting on you,
                                            above what merely happened.
                                            Absent entirely when nothing
                                            qualifies — an empty "Needs
                                            you" heading is a heading
                                            that has to be read and
                                            dismissed every time */}
                                            <box
                                                cssClasses={["zone", "needs"]}
                                                orientation={Gtk.Orientation.VERTICAL}
                                                visible={needsYou.as(l => l.length > 0)}
                                            >
                                                <label
                                                    cssClasses={["zoneTitle"]}
                                                    label="Needs you"
                                                    xalign={0}
                                                />
                                                <For each={needsYou} id={r => r.key}>
                                                    {r => <ItemRow row={r} />}
                                                </For>
                                            </box>
                                            <box
                                                cssClasses={["zone", "feed"]}
                                                orientation={Gtk.Orientation.VERTICAL}
                                                visible={feedBlocks.as(b => b.length > 0)}
                                            >
                                                <label
                                                    cssClasses={["zoneTitle"]}
                                                    label="Feed"
                                                    xalign={0}
                                                />
                                                <For each={feedBlocks} id={b => b.key}>
                                                    {b =>
                                                        b.kind === "divider" ? (
                                                            <label
                                                                cssClasses={["dayDivider"]}
                                                                label={b.label}
                                                                xalign={0}
                                                            />
                                                        ) : (
                                                            <FeedGroup block={b} />
                                                        )
                                                    }
                                                </For>
                                            </box>
                                        </box>
                                    </Gtk.ScrolledWindow>
                                </box>
                            </box>
                        </revealer>
                    </box>
                </window>
            ) as Gtk.Window,
        )
    })
}
