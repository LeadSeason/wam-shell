# Calendar

Google Calendar in the clock popover: days with events get a mark on the
month grid, and an agenda lists what's coming with per-calendar colors.
Multiple calendars and multiple Google accounts merge into one view.

Section: `[calendar]`

| Key                     | Type | Default | What it does                                                                                                                                                    |
| ----------------------- | ---- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`               | bool | `true`  | Google Calendar integration at all                                                                                                                              |
| `poll_minutes`          | int  | `15`    | Minutes between syncs (never below 5); the popover also refreshes when opened, at most once a minute                                                            |
| `hidden_calendars`      | list | `[]`    | Calendar names hidden by default, matched exactly (e.g. `"Birthdays"`, `"Tasks"`); a bare name hides it in every account, `"email:Name"` only in that account   |
| `week_numbers`          | bool | `true`  | ISO-8601 week numbers down the month grid's left edge                                                                                                           |
| `reminders`             | bool | `true`  | Reminder banners for timed events, and today's/tomorrow's events listed in the notification center                                                              |
| `remind_before_minutes` | int  | `10`    | Fallback lead time for events that carry no reminder information at all                                                                                         |
| `remind_only_attending` | bool | `true`  | Banner only for events you take part in (guest list and not declined, organizer, or a personal event on your primary calendar); others still list in the center |
| `remind_popup_seconds`  | int  | `0`     | Auto-hide the reminder banner after this many seconds; `0` keeps it until dismissed                                                                             |

Reminders:

- A banner fires at the event's own Google reminder times (per-event
  overrides, else the calendar's default reminders) and again when the
  event starts. It is critical: it breaks through DND and, by default,
  never auto-hides, like an alarm clock — `remind_popup_seconds` opts
  into auto-hiding after N seconds.
- Events Google explicitly marks reminder-less stay silent;
  `remind_before_minutes` only covers events with no reminder
  information at all. Hidden calendars and all-day events never banner.
- With `remind_only_attending` (the default), events a shared calendar
  merely shows — no guest entry of yours, not your organizer — list in
  the center but don't banner. Set it to `false` to banner everything
  visible.
- In the notification center a calendar icon filters to just events;
  in-progress and starting-soon ones sit in the "Needs you" zone.
  Middle-click on a banner snoozes it for ten minutes.

The popover's Calendars pane toggles visibility at runtime; the choice
persists across restarts and overrides `hidden_calendars` in both
directions.

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
