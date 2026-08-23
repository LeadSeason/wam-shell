# Notification-center providers

External services (GitHub, Todoist, ProtonMail, YouTube, Calendar) surface
their unread items in the notification center next to the desktop
notifications, filtered by a per-provider icon in the header.

The center has **no per-provider code**. A provider is one module in
`src/lib/` that implements the interface in
`src/lib/notificationProviders.ts` and registers itself; adding one
touches no widget.

## The contract

```ts
export interface Provider {
    name: string // registry key and filter value
    iconName: string // the header filter icon
    displayName?: string // for sign-in buttons; defaults to name
    items: Accessor<ProviderItem[]> // what the center renders
    refresh(): void // stale-while-revalidate on open
    status?: Accessor<string | null> // a sync problem, or null when healthy
    signIn?(): void // interactive sign-in (YouTube)
    signInVisible?: Accessor<boolean>
    setupHint?: string | null // enabled but unconfigured
    soonestFirst?: boolean // future-dated items: next first
}
```

(Teardown is not on the interface: register a disposer with
`registerDispose` from `lib/lifecycle.ts`, run by `app.tsx` on
shutdown.)

Each `ProviderItem` is a row: `id`, `provider`, `time` (unix seconds),
`appName`, `summary`, `body`, `iconName`, optional `imagePath` and
`actions`, plus three verbs the center calls:

| verb         | meaning                                                 |
| ------------ | ------------------------------------------------------- |
| `activate()` | primary click — open it, and whatever "read" means here |
| `dismiss()`  | the provider's own "done" (mark read, complete, delete) |
| `hide()`     | session-only: out of the center, no service call        |

Two fields carry judgement rather than data:

- **`actionable`** — someone is waiting on YOU. The center lifts these
  into its "Needs you" zone above the feed. Only the provider can tell:
  a pull request you opened and one you were asked to review are the
  same shape from outside, which is why this is a flag and not something
  the center infers.
- **`status`** — shown in the empty state instead of the misleading "No
  notifications" when a sync is failing. Say what is wrong and what
  happens next ("quota exceeded — retrying in 2h"), not just that
  something went wrong.

And one flag on the provider itself:

- **`soonestFirst`** — the items are future-dated (calendar events).
  The feed is newest-first because notifications are records of things
  that happened; upcoming events read the other way, so these list
  next-first in a block above the feed. The sort lives in
  `compareRows` (`widgets/notifications/feed.ts`) and stays transitive
  by keying the direction on the group, never on a row pair.

## Writing one

Most of the plumbing already exists. Reach for it rather than
reimplementing it — these were four near-identical copies once, and a
rule with four implementations holds in three places.

| you need                          | use                                                |
| --------------------------------- | -------------------------------------------------- |
| the config dir                    | `configHome` (`lib/paths.ts`)                      |
| a token from env or an env file   | `loadToken` (`lib/credentials.ts`)                 |
| an authenticated JSON HTTP client | `createJsonClient` (`lib/httpJson.ts`)             |
| Google OAuth (any Google service) | `createGoogleAuth` (`lib/googleAuth.ts`)           |
| "which items are new?"            | `newArrivals` (`lib/providerCore.ts`)              |
| "which are worth a banner?"       | `bannerCandidates` (`lib/providerCore.ts`)         |
| a persisted "already seen" set    | `createSeenStore` (`lib/seenStore.ts`)             |
| the age gate behind `refresh()`   | `createRefreshGate` (`lib/providerCore.ts`)        |
| opening a url                     | `openUrl` (`lib/providerCore.ts`)                  |
| teardown that actually runs       | `registerDispose` (`lib/lifecycle.ts`)             |
| timers and subprocesses           | the `lib/metrics.ts` wrappers, never GLib directly |

A skeleton:

```ts
const envPath = `${configHome}/example.env`
const token = Config.example.enabled ? loadToken("Example", "EXAMPLE_TOKEN", envPath) : null
export const active = Config.example.enabled && token !== null

const request = createJsonClient({
    baseUrl: "https://api.example.com",
    logTag: "Example",
    headers: () => ({ Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT }),
})

const [items, setItems] = createState<ProviderItem[]>([])
const [status, setStatus] = createState<string | null>(null)
const seen = createSeenStore(`${Config.instanceCacheDir}/example-seen.json`, "Example")

export function poll() {
    /* fetch, map, setItems, banner the fresh ones */
}
const gate = createRefreshGate(60_000, poll)
export const refresh = gate.refresh
export function dispose() {
    /* clear timers */
}
registerDispose("example", dispose)

// registration happens at IMPORT; network starts in init()
if (Config.example.enabled) {
    registerProvider({
        name: "example",
        iconName: "example-symbolic",
        displayName: "Example",
        items,
        refresh,
        dispose,
        status,
        setupHint: active ? null : "Example needs a token: …",
    } satisfies Provider)
}

export function init() {
    if (!active) return
    poll()
    pollTimer = timeoutAddSeconds("example:poll", GLib.PRIORITY_DEFAULT, minutes * 60, () => {
        poll()
        return GLib.SOURCE_CONTINUE
    })
}
```

Then: add a `[example]` section to `config.toml` (commented, with
defaults), a `getExampleConfig()` reader in `src/config.ts` (use
`createReader(configData, "example", { sectionOnly: true })` — service
sections never take top-level fallbacks), an `example-symbolic` icon in
`assets/icons/`, and `initExample()` to `app.tsx`.

## Rules that are easy to get wrong

- **Register at import, start the network in `init()`.** The center
  builds its window lazily and reads the registry when it does; a
  provider that only registers once its first poll succeeds is missing
  from the filter row until then. `app.tsx` calls every `init()`
  explicitly so startup ordering is visible in one place.
- **A provider that is enabled but unconfigured still registers**, with
  a `setupHint`. That hint is the only place a user finds out which
  environment variable to set.
- **The first poll after a first-ever run must not banner.** Use the
  seen store's `firstEverRun`: the backlog is history, not news.
- **A failed poll keeps the previous items.** Blanking the list on a
  transient error makes everything look new again on the next healthy
  sync, which then banners all of it.
- **Banners are opt-in per provider**, through
  `notifications.popup_providers`. The center is the default surface;
  interrupting the screen is a choice the user makes.
- **Never log a reply body, a header, or a token.** Method, path and
  status only — `createJsonClient` already does exactly that, which is
  half the reason it exists.
- **A mutation removes the item locally** rather than waiting for the
  next poll, and only after the service call succeeds. Removing first
  makes a failed call resurrect the row minutes later.

## Testing

Keep the mapping pure and export it: `threadData`, `taskData`,
`playlistVideoData` and `envelopeData` all turn one raw API object into
item data with no GTK and no network, and each has a test that pins the
shapes the service actually sends — including the malformed ones.

The shared helpers have their own suites (`tests/providerCore.test.ts`,
`tests/seenStore.test.ts`), so a new provider does not need to re-test
the horizon, the arrival diff or the persistence.
