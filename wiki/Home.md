# wam-shell configuration

Everything lives in one TOML file. The shell looks for it in this order
(first hit wins):

1. `$XDG_CONFIG_HOME/wam-shell/config.toml`
2. `~/.config/wam-shell/config.toml`
3. `config-override.toml` in the repo
4. `config.toml` in the repo

An empty file is valid — every option falls back to its documented
default, and an invalid value is reported on stderr and replaced with
the default. Section keys can also be set flat at the top level; the
section wins when both are set.

Credentials never go in this file: one `.env` file per service in
`~/.config/wam-shell/` (`github.env`, `todoist.env`, `protonmail.env`,
`google.env`, `harvest.env`, chmod 600), or the matching environment
variables. Each page below that needs credentials says so.

## Pages

### Panels and bar widgets

- [[Panels|Config-Panels]] — `bar_monitors`, panel geometry, `[[panel]]` blocks
- [[Workspaces|Config-Workspaces]]
- [[Tray|Config-Tray]]
- [[Media|Config-Media]]
- [[Harvest|Config-Harvest]] — time tracking widget (needs a token)

### Quick settings

- [[Quick settings|Config-QuickSettings]] — popup layout, audio meters, battery, avatar, Bluetooth
- [[Sleep timer|Config-SleepTimer]]
- [[Idle inhibit (keep awake)|Config-IdleInhibit]]
- [[Night light|Config-Hyprsunset]] — hyprsunset, hyprland only

### Notifications and service integrations

- [[Notifications|Config-Notifications]] — banners and the center
- [[GitHub|Config-GitHub]] — needs a token
- [[Todoist|Config-Todoist]] — needs a token
- [[ProtonMail|Config-ProtonMail]] — needs ProtonMail Bridge
- [[YouTube|Config-YouTube]] — Google OAuth
- [[Calendar|Config-Calendar]] — Google Calendar in the clock popover

### Look and feel

- [[General|Config-General]] — instance name, session override, OS icon, theme
- [[Appearance|Config-Appearance]] — dark/light themes, density
- [[OSD|Config-OSD]] — on-screen display
