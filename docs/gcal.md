# Google Calendar in the clock popover

Status: **implemented, parked**. Code complete and unit-tested; the live
OAuth flow has not been run yet (needs a real Google account sign-in).
Not merged.

## What it does

- Days with events get a mark (bold) on the `Gtk.Calendar` in the clock
  popover; clicking a day lists its events below the calendar.
- All calendars of the account merge into one list, each event carrying
  its calendar's color (Google's `backgroundColor`) and name (tooltip).
  `hidden_calendars` in `[calendar]` hides named calendars
  (e.g. "Birthdays").
- Sync covers ~5 months around the viewed month (`[focus-1mo,
  focus+4mo)`), re-syncs when navigation leaves the loaded window, and
  refreshes every `poll_minutes` (default 15) plus on popover open
  (age-gated 60 s). Events are cached to
  `$XDG_CACHE_HOME/wam-shell/gcal-events.json` for instant marks on
  shell start.

## Setup (also in config.toml comments)

1. Google Cloud Console → project → enable **Google Calendar API** →
   Credentials → **OAuth client ID** → type **Desktop app**.
2. `~/.config/wam-shell/google.env` (chmod 600):
   `GOOGLE_CLIENT_ID=...`, `GOOGLE_CLIENT_SECRET=...`
3. `[calendar] enabled = true`, restart, open the clock popover →
   **Sign in to Google Calendar** (browser consent once).
4. Google warns "unverified app" for personal clients — Advanced →
   proceed.

## Design notes

- `src/lib/gcal.ts`, mirrors `lib/harvest.ts` conventions: env-or-file
  credentials, perms warning, Soup session, metrics wrappers, explicit
  `init()` from `app.tsx`, `dispose()`.
- Auth: OAuth2 installed-app flow, loopback redirect (RFC 8252) on a
  random 127.0.0.1 port via `Gio.SocketListener`; refresh token at
  `~/.config/wam-shell/gcal-tokens.json`. Read-only scope only
  (`calendar.readonly`). `invalid_grant` → tokens wiped, popover shows
  the sign-in button again.
- Sync is a **full refetch** of the window (no syncToken/incremental
  machinery): small, quota-cheap, stateless. Pagination capped at 10
  pages per request. A failed calendar degrades to zero events for it
  instead of failing the merge.
- Google quirks handled in `mapGoogleEvent` (unit-tested): `status:
  cancelled` dropped, all-day `end.date` is **exclusive**, timed events
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

- Read-only: no event creation/editing, no reminders/notifications.
- Marks are Gtk.Calendar's boolean bold dot — no per-calendar color or
  count on the calendar grid.
- Calendar selection is opt-out by exact name; no per-calendar toggle
  in the UI.
