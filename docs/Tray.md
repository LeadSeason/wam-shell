The `Astral.TrayItem::get_item_id` correspond to the the ID retrieved from `Astral.Tray::get_item`. This ID is used to identify and manage individual tray items within the system tray.

An app may have multiple tray items. What is consistent though is that each tray item will have the same `get_id()`, `get_title()`, and `get_gicon()` values if they belong to the same application. Furthermore, even after restarting AGS they maintain the same item id, and registration order. **I don't know why an app would have multiple tray items.**

## The `$`etup function

This is a setup function that is called when the widget is created. If we do not initialize the action group, the actionable buttons within the popover menu will be disabled as no action is associated with them.

https://aylur.github.io/gnim/jsx#setup-function-1

## Methods

### `get_item_id(): string`

This is the internal identifier for the tray item. When you need to uniquely identify a tray item, use this ID.

```ts
trayItem.get_item_id() // :1.195/StatusNotifierItem
```

### `get_id(): string`

This seems to be the app's identifier for the tray item. It often corresponds to the application name or a unique identifier for the application that created the tray item.

```ts
trayItem.get_id() // TelegramDesktop
```

### `get_gicon(): Gio.Icon`

```ts
trayItem.get_gicon()?.to_string() // org.telegram.desktop-attention-symbolic
```

### `get_title(): string`

```ts
trayItem.get_title() // TelegramDesktop
```

## Finding an app's SNI Id

Needed for the `tray.always_on_panel` config. Entries are matched
against the SNI Id, title and icon name, and as a substring of the
tooltip. Electron apps all report `chrome_status_icon_1` as their Id
with an empty title and no icon name — match them by tooltip instead
(e.g. `"Connected"` for Mullvad VPN, `"Ferdium"` for Ferdium).

Two ways to discover ids:

1. The shell logs each id once as items register on startup:
   `Tray item added: TelegramDesktop`
2. Query the watcher over D-Bus while the shell is running:

```sh
for item in $(busctl --user get-property org.kde.StatusNotifierWatcher /StatusNotifierWatcher org.kde.StatusNotifierWatcher RegisteredStatusNotifierItems | grep -oP '"\K[^"]+'); do
  bus="${item%%/*}"; path="/${item#*/}"
  busctl --user get-property "$bus" "$path" org.kde.StatusNotifierItem Id 2>/dev/null | cut -d'"' -f2
done
```

## Bar vs quick settings layout

The tray renders as a wrapping `Gtk.FlowBox` (8 per line) inside quick
settings, where the grid is wanted. On the bar it is a single-row `box`
(`singleRow` prop): a wrapping FlowBox grows the whole panel, because
the bar window's `heightRequest` is a floor and not a cap — a 9th tray
item used to wrap onto a second line and show up as a full-width strip
under the bar holding the overflow icons.

## Late-resolving and hollow items

An item's properties (id, title, tooltip, icon) resolve asynchronously
after `item-added` — Electron apps register a hollow item first and
fill it in later. The pinned/unpinned filter is therefore re-evaluated
on every relevant `notify::`, otherwise a pinned item that resolved
late would stay in quick settings forever and never reach the bar.

Items whose `gicon` is null are not rendered at all. A hollow
registration — an Electron app whose D-Bus object died: it exports an
empty node, no properties at all — would otherwise sit in the grid as
an empty, useless pill. Such an item can also never match
`tray.always_on_panel` (there is no id, title or tooltip to match); it
reappears if the app starts serving properties again.

## Icon spacing (`tray.spacing`)

`spacing` controls the gap **between tray icons** (never the gap
between the tray widget and other panel widgets — that is CSS
territory, `.trayItem` / panel margins):

- `0` (default): no inline margins are set, so stylesheet rules control
  the gap — override freely in `scss/user.scss`:

    ```scss
    .trayItem {
        margin-right: 12px;
    }
    ```

- non-zero: a **multiplier** of the 6px base unit
  (`$bar-widget-spacing` in `scss/conf.scss`), applied as an inline
  margin on each icon: `spacing = 2` → 12px, `spacing = 3` → 18px.
  Inline styles beat the stylesheet, so a non-zero value always wins
  over CSS.
