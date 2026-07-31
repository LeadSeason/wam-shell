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
    url: string // opened by activate()
    dismiss(): void // remove from the center (provider-specific meaning)
    activate(): void // primary click: open + whatever "read" means here
}

export interface Provider {
    name: string // registry key and filter value ("github")
    iconName: string // the header filter icon
    // the registry only holds active providers (enabled + credentials);
    // the center checks nothing else
    items: Accessor<ProviderItem[]>
    // stale-while-revalidate when the center opens; providers age-gate
    refresh(): void
    dispose(): void
}

// plain array: providers register at module scope (their init may not
// have run yet — registry presence must not depend on network), the
// center iterates it when building its (lazy) window
export const providers: Provider[] = []

export function registerProvider(p: Provider) {
    if (!providers.some(x => x.name === p.name)) providers.push(p)
}
