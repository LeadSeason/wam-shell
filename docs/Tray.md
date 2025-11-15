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
