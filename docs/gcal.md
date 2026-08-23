# Google Calendar in the clock popover

Status: **implemented, parked**. Code complete and unit-tested; the live
OAuth flow has not been run yet (needs a real Google account sign-in).
Not merged.

## What it does

- Days with events get a mark (bold) on the `Gtk.Calendar` in the clock
  popover; below it an **agenda** (Google's schedule layout) lists days
  with events from the selected day onward — "Today", "Tomorrow", then
  dated headers, empty days skipped. Clicking a day in the month grid
  starts the agenda there.
- All calendars of **every signed-in Google account** merge into one
  list, each event carrying its calendar's color (Google's
  `backgroundColor`) and name + account in the tooltip.
  `hidden_calendars` in `[calendar]` hides named calendars
  (e.g. "Birthdays"); `"email:Name"` hides one in a single account.
- Sync covers ~5 months around the viewed month
  (`[focus-1mo, focus+4mo)`), re-syncs when navigation leaves the loaded
  window, and
  refreshes every `poll_minutes` (default 15) plus on popover open
  (age-gated 60 s). Events are cached to
  `$XDG_CACHE_HOME/wam-shell/gcal-events.json` for instant marks on
  shell start.

## Setup (also in config.toml comments)

1. Nothing to create: the project ships an OAuth desktop client
   (installed-app client secrets are public per Google's docs).
2. `[calendar] enabled = true`, restart, open the clock popover →
   **Sign in to Google Calendar** (browser consent once per account;
   the button becomes **+ Add Google account** for the next one).
3. Google's consent screen warns "unverified app" — Advanced →
   proceed. Managed Workspace accounts may be blocked by org policy.
4. Prefer your own client (no warning, no test-user cap)? Create an
   OAuth client ID (type **Desktop app**) at console.cloud.google.com
   and drop it in `~/.config/wam-shell/google.env` (chmod 600):
   `GOOGLE_CLIENT_ID=...`, `GOOGLE_CLIENT_SECRET=...` — it wins over
   the embedded one.

## The embedded OAuth client: what it is, and when to stop using it

The project ships a client id and secret in `src/lib/googleAuth.ts`.
That is deliberate and it is what Google's own installed-app guidance
says to do — a desktop client's secret is not a credential, because
anyone with the binary has it, which is exactly why the flow is
PKCE-protected and why the loopback redirect is bound to the local
machine. It is not a leak, and rotating it on discovery would be
pointless.

What it _is_ is a **shared resource**, and that has consequences worth
stating rather than discovering:

- **The daily quota is shared across everyone using the shipped
  client.** Calendar's is generous and the sync is small (a full refetch
  of a ~5-month window, per account, every 15 minutes by default), so
  this has never been the binding constraint. YouTube is the one to
  watch: each sweep costs roughly one quota unit per subscription, which
  is why `youtube.poll_minutes` has a floor and the provider raises its
  own interval when the subscription count would exceed the headroom.
- **A quota day looks like an outage, not like a quota.** Both surface
  as `Couldn't sync … — retrying in Nm` in the center's empty state with
  the HTTP status attached. A `403` there is the tell.
- **The consent screen says "unverified app".** That is the project's
  verification status, not a problem with your account. Managed
  Workspace accounts may be blocked from proceeding at all by org
  policy.
- **It is a single point of failure for every install at once.** The
  quota and the warning are inconveniences; this one is not. If the
  Cloud project behind the shipped client is deleted, suspended, or
  fails a verification review, then Calendar and YouTube stop working
  for _everybody_ on the same day, and what a user sees is a token
  exchange that fails with no explanation attached to it. There is
  nothing a release can do about that after the fact — the only
  insulation is not depending on it.

    So: if you rely on the calendar or the YouTube feed for anything that
    matters, use your own client. It takes about five minutes, it is the
    difference between a dependency you control and one you do not, and
    the shipped client is best understood as a way to _try_ the feature
    rather than a foundation to build a workday on.

**Use your own client if any of that bites you** — a quota you do not
share, no unverified warning, no test-user cap. Create an OAuth client
ID of type _Desktop app_ at `console.cloud.google.com`, enable the
Calendar and/or YouTube Data APIs on the project, and put it in
`~/.config/wam-shell/google.env` (chmod 600):

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

or set the same names as environment variables. Precedence is env vars >
`google.env` > the embedded client, resolved in `loadCredentials()`.
Switching clients invalidates existing refresh tokens: the accounts drop
themselves on the next refresh (`invalid_grant`) with a re-sign-in hint,
which is self-healing but means one extra sign-in per account.

**If the shipped client ever has to be replaced** — abuse, a Google
policy change, a project deletion — the change is the two constants in
`src/lib/googleAuth.ts` and nothing else. Every stored refresh token
becomes invalid at that moment; the existing `invalid_grant` path
already handles it by dropping the account and asking for a new
sign-in, so no migration code is needed, but the release note has to say
so, because to a user it looks like being randomly signed out.

## Design notes

- `src/lib/gcal.ts`, mirrors `lib/harvest.ts` conventions: env-or-file
  credentials, perms warning, Soup session, metrics wrappers, explicit
  `init()` from `app.tsx`, `dispose()`.
- Auth: OAuth2 installed-app flow, loopback redirect (RFC 8252) on a
  random 127.0.0.1 port via `Gio.SocketListener`, with PKCE (S256) and a
  per-flow `state` nonce; the listener loops until a redirect carries a
  valid `code`/`error` (preconnects, favicons and bad-state requests get
  a 4xx and don't end the flow). **One OAuth client, any number of
  accounts** — refresh tokens per account, keyed by email (discovered
  from the primary calendar's id, no extra scope). Tokens are stored in
  the Secret Service keyring when available (`src/lib/secretStore.ts`),
  falling back to mode-0600 `~/.config/wam-shell/gcal-tokens.json`; the
  file always keeps account metadata + short-lived access tokens.
  Read-only scope only
  (`calendar.readonly`). `invalid_grant` drops just that account;
  the popover's sign-in button adds/re-authorizes accounts.
- Sync is a **full refetch** of the window per account (no syncToken/
  incremental machinery): small, quota-cheap, stateless. Pagination
  capped at 10 pages per request. A failed account or calendar degrades
  to zero events for it instead of failing the merge.
- Google quirks handled in `mapGoogleEvent` (unit-tested):
  `status: cancelled` dropped, all-day `end.date` is **exclusive**, timed
  events
  ending at midnight don't spill, zero-length events cover their start
  day, recurring events expanded server-side (`singleEvents=true`).
- The calendar color dot is the shell's only inline style (per-calendar
  API data, not themeable).

## Remaining (resume checklist)

1. Live-verify the OAuth flow + event rendering (steps above): marks,
   day list, multi-calendar colors, `hidden_calendars`, month
   navigation past the loaded window, token refresh after ~1 h.
2. Gates: `node_modules/.bin/prettier --check "src/**/*.{ts,tsx}"`,
   `bash tests/run.sh` (45 suites), clean start
   (`timeout 8 ags run app.tsx` — grep for `ERROR` too, esbuild bundle
   failures don't match `JS ERROR`), `bash tests/perf/compare.sh`.
3. Sync branch with `git fetch origin && git merge origin/develop`,
   then PR + merge per repo workflow.

## Known limitations (v1, deliberate)

- Read-only: no event creation/editing. (Reminder banners and the
  center's calendar provider live in `lib/gcalReminders.ts`.)
- Marks are Gtk.Calendar's boolean bold dot — no per-calendar color or
  count on the calendar grid.
- Calendar selection is opt-out by exact name; no per-calendar toggle
  in the UI.
