# Notifications

Notification banners (transient popups) and the notification center.

Section: `[notifications]`

| Key               | Type                                  | Default      | What it does                                                                                                                                                                                                                                             |
| ----------------- | ------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `daemon`          | `"auto"` / `"wam-shell"` / `"system"` | `"auto"`     | Whose notification daemon is used: `auto` defers to a running system daemon (swaync, dunst, …) and otherwise uses wam-shell's; `"wam-shell"` forces ours; `"system"` forces the system's even when none is running (nothing displays notifications then) |
| `popups`          | bool                                  | `true`       | Transient banners for incoming notifications — a card with a countdown bar that follows the focused monitor, freezes on hover and respects do-not-disturb (critical still breaks through). Only when wam-shell's daemon is used                          |
| `popup_timeout`   | ms                                    | `5000`       | How long before a popup hides itself, when the notification does not ask for a length of its own. Low urgency drains in half the time; critical stays until dismissed                                                                                    |
| `position`        | `"topRight"` / `"topCenter"`          | `"topRight"` | Where banners appear                                                                                                                                                                                                                                     |
| `popup_width`     | int (px)                              | `460`        | Fixed banner width; the whole stack keeps one width as notifications arrive and expire                                                                                                                                                                   |
| `transient_apps`  | list of strings                       | `[]`         | App names (matched case-insensitively) whose notifications are popup-only: shown as banners but excluded from the center's history                                                                                                                       |
| `popup_providers` | list of strings                       | `[]`         | Provider names (`"github"`, `"youtube"`, …) whose items may also raise transient banners alongside the center; empty = provider notifications live in the center only                                                                                    |

- The daemon choice is made at startup — restart the shell after changing daemons. Forcing `"wam-shell"` while another daemon already owns the bus name still leaves notifications with that daemon.
- A sender's requested timeout always wins over `popup_timeout` (`0` = stays until dismissed); the setting only applies when the sender leaves it unspecified.
- Notifications carrying the spec "transient" hint are always excluded from the center, regardless of `transient_apps`.
- Provider banners respect do-not-disturb, and the first sync after startup is a silent baseline — no banners for items that were already there.
