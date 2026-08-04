import { Accessor } from "gnim"

// Provider integrations for the notification center: external services
// (GitHub today, YouTube/ProtonMail later) surface their unread items
// next to the desktop notifications, and a provider icon in the
// center's header filters the list to just that provider. A provider
// is one lib module implementing the interface below plus an entry in
// the registry — the center needs no per-provider code.

export interface ProviderItem {
    id: string // "<provider>:<native id>" — unique across providers
    provider: string // registry key, e.g. "github"
    time: number // unix seconds (matches AstalNotifd.Notification.time)
    // where the app name sits on a desktop row; reuses the center's
    // app-name text filter (for GitHub: the repository's full name)
    appName: string
    summary: string
    body: string // secondary line ("" hides it)
    iconName: string // row icon (usually the provider's)
    // optional thumbnail (YouTube): a local file the card renders in
    // the image slot; absent = the icon shows instead
    imagePath?: string
    url: string // opened by activate()
    // optional button row (rendered like the desktop card's .actions
    // row). run() executes after the host's onAction; a host may consume
    // an id (the banner consumes "dismiss" so the item survives in the
    // center)
    actions?: { id: string; label: string; run(): void }[]
    hide(): void // session-scoped: out of the center, no service-side call
    dismiss(): void // "mark done" — the provider's done semantics
    activate(): void // primary click: open + whatever "read" means here
}

export interface Provider {
    name: string // registry key and filter value ("github")
    iconName: string // the header filter icon
    displayName?: string // for sign-in buttons ("YouTube"); defaults to name
    // the registry only holds active providers (enabled + credentials);
    // the center checks nothing else
    items: Accessor<ProviderItem[]>
    // stale-while-revalidate when the center opens; providers age-gate
    refresh(): void
    dispose(): void
    // a sync problem to surface in the center's empty state ("quota
    // exceeded, retrying in 2h"), null when healthy. Shown instead of
    // the misleading "No notifications"
    status?: Accessor<string | null>
    // providers behind an interactive sign-in (YouTube): the center
    // offers the button when the provider's filter is selected and
    // signInVisible is true (typically "no accounts yet")
    signIn?(): void
    signInVisible?: Accessor<boolean>
    // enabled but not configured (no credentials): instructions shown
    // in the center's empty state when the provider's filter is
    // selected. null/absent when properly configured
    setupHint?: string | null
}

// plain array: providers register at module scope (their init may not
// have run yet — registry presence must not depend on network), the
// center iterates it when building its (lazy) window
export const providers: Provider[] = []

export function registerProvider(p: Provider) {
    if (!providers.some(x => x.name === p.name)) providers.push(p)
}
