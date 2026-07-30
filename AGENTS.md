# wam-shell conventions

## Runtime services

- Notifications come from AstalNotifd — by default the shell IS the
  notification daemon. If the user runs another daemon (swaync, dunst),
  the shell defers to it at startup (`[notifications] daemon`, default
  "auto"); "wam-shell"/"system" force one or the other. Running swaync
  alongside is still not recommended.
- The app launcher and notification center toggle via request
  commands: `ags request -i wam-shell launcher` and
  `ags request -i wam-shell notifications` (bind these in the
  compositor config).

## Widgets must be CSS-targetable

Every new widget (bar module, quick settings section, etc.) must carry
a stable CSS class so users can style it from scss — spacing, colors,
per-panel overrides (`window.Bar.<panel-class>`), and per-widget margin
tweaks. Name classes after the widget (`.sysStats`, `.keyboardLayout`,
`.swayNC`) and add it to the widget-class list comment in
`scss/widgets/bar/bar.scss`.

## Config

- User-facing options live in `config.toml` (all commented, with
  defaults documented) and are parsed in `src/config.ts`.
- After any config change, regenerate `config-override.toml`: copy of
  `config.toml` plus the user's active values appended.

## Styling

- Colors come from the active theme (`scss/theme/*.scss`, selected via
  the `theme` config key) — never hardcode hex in widget styles.
- Shared spacing/radius values live in `scss/conf.scss`.

## Formatting

- Prettier is the formatter; config lives in `.prettierrc` (there is
  intentionally no `prettier` key in package.json — it would shadow the
  file). Run `node_modules/.bin/prettier --check "src/**/*.{ts,tsx}"`
  before committing; a pre-commit hook running the same command (or
  `--write`) is recommended.
- Imports of gnim API (`createState`, `For`, `With`, accessors) come
  from `"gnim"`, GObject from `"ags/gobject"` — not from `"ags"`.

## Commits

- One logical change per commit; split unrelated changes into separate
  commits when asked.
- Before merging a branch, do a code review of its changes
  (correctness, races, leaks, consistency) unless one was already done
  in this session.
- Verify the shell starts clean before committing:
  `ags quit -i wam-shell; timeout 8 ags run app.tsx` (no Gjs-CRITICAL /
  JS ERROR output).
