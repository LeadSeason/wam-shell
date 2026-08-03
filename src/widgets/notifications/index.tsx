import { Astal, Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib?version=2.0"
import Graphene from "gi://Graphene?version=1.0"
import AstalNotifd from "gi://AstalNotifd?version=0.1"
import app from "ags/gtk4/app"
import { For, createComputed, createRoot, createState } from "gnim"
import notifd, { count, dnd, persistent, toggleDnd } from "../../lib/notifd"
import { createBinding } from "gnim"
import CommandRegistry from "../../lib/requestHandler"
import { timeoutAdd, sourceRemove } from "../../lib/metrics"
import { hideOnFocusLoss } from "../../lib/popupFocus"
import { providers } from "../../lib/notificationProviders"
import type { ProviderItem } from "../../lib/notificationProviders"
import NotificationCard from "./NotificationCard"
import ProviderCard from "./ProviderCard"
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

function show() {
    if (hideSource !== null) {
        sourceRemove(hideSource)
        hideSource = null
    }
    // stale-while-revalidate provider inboxes on open (age-gated)
    for (const p of providers) p.refresh()
    win!.present()
    rev!.revealChild = true
    searchEntry?.grab_focus()
}

function hide() {
    // the next open starts with an empty search: reset the state AND
    // the entry's text (they're separate — one doesn't follow the other)
    setQuery("")
    searchEntry?.set_text("")
    rev!.revealChild = false
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

const notifications = createBinding(notifd, "notifications")
// flat list of the center's history (transient-hinted and filtered apps
// excluded), newest first (ties broken by id: notifications sent within
// the same second still order by arrival)
const sorted = persistent.as(list => [...list].sort((a, b) => b.time - a.time || b.id - a.id))

// header filter: case-insensitive substring match on the app name.
// createComputed over both inputs: sorted.as alone would not recompute
// when the query changes
const [query, setQuery] = createState("")

// provider integrations (GitHub & co.): their items merge into the
// list; a header icon per provider filters to just its items
const [providerFilter, setProviderFilter] = createState<string | null>(null)
// special filter value: only the local daemon's notifications
const LOCAL_FILTER = "local"

interface Row {
    key: string
    time: number
    desktop: AstalNotifd.Notification | null
    item: ProviderItem | null
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
                    rows.push({ key: `desktop:${n.id}`, time: n.time, desktop: n, item: null })
                }
            }
            providers.forEach((p, i) => {
                if (pFilter && p.name !== pFilter) return
                for (const item of vals[1 + i] as ProviderItem[]) {
                    rows.push({
                        // the thumb path is part of the key: gnim's For
                        // reuses rows by key, so a thumbnail landing
                        // after the row was built must change the key
                        // to get a rebuild with the image
                        key: `provider:${item.id}:${item.imagePath ?? ""}`,
                        time: item.time,
                        desktop: null,
                        item,
                    })
                }
            })
            const needle = q.trim().toLowerCase()
            const filteredRows =
                needle === ""
                    ? rows
                    : rows.filter(r =>
                          (r.desktop?.appName || r.item?.appName || "")
                              .toLowerCase()
                              .includes(needle),
                      )
            return filteredRows.sort((a, b) => b.time - a.time)
        },
    )
}
let merged: ReturnType<typeof buildMerged>

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

function ensureWindow() {
    if (win) return
    const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor
    createRoot(() => {
        merged = buildMerged()
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
                                <box cssClasses={["header"]} spacing={6}>
                                    <entry
                                        $={self => {
                                            searchEntry = self
                                        }}
                                        cssClasses={["filter", "textInput"]}
                                        placeholderText="Filter by app…"
                                        hexpand
                                        onChanged={self => setQuery(self.text)}
                                    />
                                    <button
                                        tooltipText="Do not disturb"
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
                                                  : "Pick a filter to clear",
                                        )}
                                        onClicked={() => {
                                            const f = providerFilter.get()
                                            if (f === LOCAL_FILTER) {
                                                for (const n of [...notifications.get()])
                                                    n.dismiss()
                                            } else if (f) {
                                                const p = providers.find(x => x.name === f)
                                                for (const item of [...(p?.items.get() ?? [])])
                                                    item.dismiss()
                                            }
                                        }}
                                    >
                                        <image iconName="user-trash-symbolic" />
                                    </button>
                                </box>
                                {/* local + provider filter icons on
                                their own row: click to show only that
                                source, again to go back. Static by
                                window-build time — plain map, no
                                reactivity needed */}
                                <box cssClasses={["filtersRow"]} spacing={6}>
                                    <button
                                        cssClasses={providerFilter.as(f => [
                                            "provider",
                                            ...(f === LOCAL_FILTER ? ["active"] : []),
                                        ])}
                                        tooltipText={"Show only local notifications"}
                                        onClicked={() =>
                                            setProviderFilter(
                                                providerFilter.get() === LOCAL_FILTER
                                                    ? null
                                                    : LOCAL_FILTER,
                                            )
                                        }
                                    >
                                        <box spacing={4}>
                                            <image iconName="computer-symbolic" />
                                            {/* pending count, hidden at 0 */}
                                            <label
                                                cssClasses={["count"]}
                                                label={count.as(n => (n > 0 ? String(n) : ""))}
                                            />
                                        </box>
                                    </button>
                                    {providers.map(p => (
                                        <button
                                            cssClasses={providerFilter.as(f => [
                                                "provider",
                                                ...(f === p.name ? ["active"] : []),
                                            ])}
                                            tooltipText={`Show only ${p.name} notifications`}
                                            onClicked={() =>
                                                setProviderFilter(
                                                    providerFilter.get() === p.name ? null : p.name,
                                                )
                                            }
                                        >
                                            <box spacing={4}>
                                                <image iconName={p.iconName} />
                                                <label
                                                    cssClasses={["count"]}
                                                    label={p.items.as(l =>
                                                        l.length > 0 ? String(l.length) : "",
                                                    )}
                                                />
                                            </box>
                                        </button>
                                    ))}
                                </box>
                                <Gtk.Separator />
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
                                            spacing={8}
                                        >
                                            <For each={merged} id={r => r.key}>
                                                {r =>
                                                    r.desktop ? (
                                                        <NotificationCard
                                                            n={r.desktop}
                                                            onDismiss={() => r.desktop!.dismiss()}
                                                        />
                                                    ) : (
                                                        <ProviderCard item={r.item!} />
                                                    )
                                                }
                                            </For>
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
