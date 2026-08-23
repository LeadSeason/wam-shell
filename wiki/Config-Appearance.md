# Appearance

Which themes the Dark Style toggle switches between, how much spacing
the shell gets, and whether surfaces are frosted.

Section: `[appearance]`

| Key                  | Type                                        | Default              | What it does                                                                                                                                               |
| -------------------- | ------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dark_theme`         | string                                      | `"catppuccin-mocha"` | Theme applied when the Dark Style quick settings toggle turns on                                                                                           |
| `light_theme`        | string                                      | `"catppuccin-latte"` | Theme applied when the Dark Style toggle turns off                                                                                                         |
| `follow_system`      | bool                                        | `true`               | Also follow the system color scheme at startup, so Dark Style survives a shell restart                                                                     |
| `density`            | `"compact"` / `"comfortable"` / `"relaxed"` | `"comfortable"`      | How much air the shell gets; scales spacing only (padding and gaps) — text and icons stay the same size. `"compact"` is for small screens, not small type  |
| `blur`               | bool                                        | `false`              | Frosted-glass surfaces: popups and the bar go translucent and the compositor blurs whatever shows through. Hyprland only                                   |
| `blur_opacity`       | number                                      | `0.85`               | How see-through surfaces get with `blur` on (0.5–1); lower shows more blur but costs text contrast                                                         |
| `blur_in_powersaver` | bool                                        | `true`               | Keep the frost while the power-saver profile is active; `false` suspends blur (surfaces opaque, compositor rules off) until the profile leaves power-saver |

- Dark Style changes are live only; the top-level `theme` key wins
  again on restart unless `follow_system` is on.
- A `density` change recompiles the stylesheet on next start; run
  `ags request -i wam-shell style` to apply it immediately.
- `blur` needs Hyprland's layer blur — on any other session surfaces
  stay opaque. The shell applies the layerrules itself at startup as
  runtime keywords, so a `hyprctl reload` drops them until the shell
  restarts; for rules that survive reloads, add
  `layerrule = blur, match:namespace <namespace>` lines to
  `hyprland.conf` instead (namespaces: `bar`, `osd`, `notifications`,
  `notification-popups`, `launcher`, `media-popup`, `harvest-popup`,
  `session-menu`, `bluetooth-pairing`, and `<instance_name>QSettings` /
  `<instance_name>Dialog` — `wam-shellQSettings` / `wam-shellDialog`
  with the default instance name). Blur strength (radius, passes,
  noise) is Hyprland's own `decoration:blur`, not a shell setting.
