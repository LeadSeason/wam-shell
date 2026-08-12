# ProtonMail

ProtonMail unread mail in the notification center, via ProtonMail
Bridge's local IMAP. The unread INBOX merges into the list newest-first
with sender + subject; a ProtonMail icon in the header filters to them.
Clicking opens webmail; dismissing marks the mail SEEN on the bridge.

Section: `[protonmail]`

| Key | Type | Default | What it does |
|---|---|---|---|
| `enabled` | bool | `true` | Master toggle (requires credentials) |
| `poll_minutes` | int | `2` | Minutes between syncs (clamped to at least 1); the center also refreshes when opened, at most once a minute |
| `host` | string | `"127.0.0.1"` | Bridge IMAP host |
| `port` | int | `1143` | Bridge IMAP port |
| `tls` | bool | `false` | Speak STARTTLS before logging in. IMAP LOGIN sends the password in the clear: fine on loopback (how the bridge is meant to be used), but with `host` pointing at another machine the provider refuses to start unless this is `true` |
| `tls_insecure` | bool | `false` | Accept the bridge's self-signed certificate without verifying it; keeps the password off the wire but does not prove you are talking to your bridge — only on a network you trust |

Setup:

- Install `protonmail-bridge`, keep it running and signed in; the bridge
  app shows the IMAP username and bridge password under Mailbox details.
- Put `PROTONMAIL_IMAP_USER` and `PROTONMAIL_IMAP_PASSWORD` in
  `~/.config/wam-shell/protonmail.env` (`chmod 600`), not in config.toml.
- Same-named environment variables work too and win over the file.
- Without credentials the provider stays off even when enabled.
