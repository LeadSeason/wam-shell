# Calendar

Google Calendar in the clock popover: days with events get a mark on the
month grid, and an agenda lists what's coming with per-calendar colors.
Multiple calendars and multiple Google accounts merge into one view.

Section: `[calendar]`

| Key | Type | Default | What it does |
|---|---|---|---|
| `enabled` | bool | `true` | Google Calendar integration at all |
| `poll_minutes` | int | `15` | Minutes between syncs (never below 5); the popover also refreshes when opened, at most once a minute |
| `hidden_calendars` | list | `[]` | Calendar names hidden by default, matched exactly (e.g. `"Birthdays"`, `"Tasks"`); a bare name hides it in every account, `"email:Name"` only in that account |
| `week_numbers` | bool | `true` | ISO-8601 week numbers down the month grid's left edge |

The popover's Calendars pane toggles visibility at runtime; that choice
is session-only and overrides `hidden_calendars`.

Signing in:

- The project ships an OAuth desktop client — nothing to set up. Set
  `enabled = true`, restart the shell, open the clock popover and click
  "Sign in to Google Calendar"; one browser consent (read-only) per
  account, "+ Add Google account" for more.
- Google's consent screen warns about an "unverified app" — Advanced →
  proceed. Tokens are stored in `~/.config/wam-shell/gcal-tokens.json`.
- To use your own OAuth client instead (recommended if you rely on this —
  the shipped client's quota is shared by every install): create a client
  ID of type "Desktop app" at console.cloud.google.com and put it in
  `~/.config/wam-shell/google.env` as `GOOGLE_CLIENT_ID` /
  `GOOGLE_CLIENT_SECRET` (chmod 600, never in config.toml). Same-named
  environment variables also work and take precedence.
