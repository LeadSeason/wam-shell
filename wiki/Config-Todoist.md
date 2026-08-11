# Todoist

Todoist tasks in the notification center. Scheduled tasks due at a
concrete time today or tomorrow merge into the list, soonest first; a
Todoist icon in the header filters to them. Clicking opens the task in
the browser; dismissing **completes** the task on Todoist. All-day and
overdue tasks are not listed — this is about time-critical tasks, not
historical records.

Section: `[todoist]`

| Key | Type | Default | What it does |
|---|---|---|---|
| `enabled` | bool | `true` | Master toggle (requires the API token below) |
| `poll_minutes` | int | `5` | Minutes between syncs (at least 1); the center also refreshes when opened, at most once a minute |
| `reminders` | bool | `true` | Raise a banner for a scheduled task at its Todoist reminder time and again at the due moment; high priority, stays until dismissed |
| `remind_before_minutes` | int | `5` | Fallback banner time for tasks without a Todoist reminder: this many minutes before due |
| `snooze_minutes` | int | `30` | The banner's Postpone button re-raises it this many minutes later, capped at the due time; local only, the task on Todoist is never changed |

## Authentication

- Create an API token in Todoist settings (Integrations → Developer).
- Put it in `~/.config/wam-shell/todoist.env` as `TODOIST_API_TOKEN=…`,
  then `chmod 600` the file — never put it in `config.toml`.
- Setting the `TODOIST_API_TOKEN` environment variable also works and
  takes precedence.
- Without a token the provider stays off even when `enabled` is `true`.
