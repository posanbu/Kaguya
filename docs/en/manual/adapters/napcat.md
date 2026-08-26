---
title: Connect QQ with the NapCat Adapter
---

# Connect QQ with the NapCat Adapter

The current NapCat adapter is a MaiBot plugin. NapCat provides a **Forward WebSocket (WebSocket server)**; the adapter connects to it as a client and passes messages to MaiBot through the plugin message gateway.

::: info Connection direction
`NapCat WebSocket server ← NapCat adapter client → MaiBot plugin message gateway`

The plugin version does not use `[maim_message]`, and NapCat does not need a Reverse WebSocket entry.
:::

Adapter source: [Mai-with-u/MaiBot-Napcat-Adapter](https://github.com/Mai-with-u/MaiBot-Napcat-Adapter)

## 1. Install and Log In to NapCat

Follow the [NapCat documentation](https://napneko.github.io/guide/boot/Shell) and log in with the QQ side account used by the bot.

## 2. Enable a Forward WebSocket Server

In NapCat WebUI network settings:

1. Create or enable a **Forward WebSocket / WebSocket Server** entry.
2. Set its bind address and port; `3001` is commonly used.
3. Optionally set an access token. If set, enter the same token in the adapter later.

Do not confuse the NapCat WebUI token, MaiBot WebUI Access Token, and WebSocket access token.

## 3. Configure MaiBot's Bot Account

Set the platform and QQ account in WebUI basic settings, or edit `config/bot_config.toml`:

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[bot]
platform = "qq"
qq_account = "123456789"
```

:::

`qq_account` must match the QQ account actually logged in through NapCat. NapCat logs that account into QQ, while MaiBot core uses this setting to identify messages sent by the bot itself. The plugin adapter does not use `[maim_message]`, but it still requires `[bot].qq_account`.

## 4. Install and Enable the Adapter

Open **Plugin Management** in MaiBot WebUI, install **NapCat Adapter** from the plugin marketplace, and enable it manually. Its default configuration is disabled, so a successful installation alone does not start it.

If the marketplace is unavailable, clone the repository into MaiBot's `plugins/` directory:

::: code-group

```bash [Bash ~vscode-icons:file-type-shell~]
git clone https://github.com/Mai-with-u/MaiBot-Napcat-Adapter.git plugins/MaiBot-Napcat-Adapter
```

:::

After a manual clone, use the WebUI to enable and configure it. The actual directory name may vary by installation method, so do not use a hard-coded directory name as proof that installation succeeded.

## 5. Configure the Connection

Set these fields in the NapCat Adapter settings:

**`napcat_server.host`** — NapCat's address. Use `127.0.0.1` when both processes run on the same host, or the service name `napcat` with the project's Docker Compose file.

**`napcat_server.port`** — The Forward WebSocket listening port, such as `3001`.

**`napcat_server.token`** — The Forward WebSocket access token, or empty if none is configured.

The adapter connects to an address such as `ws://127.0.0.1:3001`. After saving, its `on_config_update` lifecycle stops the old connection and reconnects with the new settings; a full MaiBot restart is normally unnecessary.

## 6. Configure Chat Lists

Chat-list filtering is enabled by default. Group and private chats both default to whitelist mode, with initially empty lists. Messages outside the lists are discarded.

You can temporarily disable filtering during testing. For regular use, keep filtering enabled and add the allowed group or QQ IDs. For example:

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[chat]
enable_chat_list_filter = true
show_dropped_chat_list_messages = true
group_list_type = "whitelist"
group_list = ["your-qq-group-id"]
```

:::

## Verification and Troubleshooting

**Plugin loaded** — NapCat Adapter is enabled in WebUI and the MaiBot log contains no load error.

**Correct direction** — NapCat runs the WebSocket server and the adapter log reports a connection to NapCat. Do not configure Reverse WebSocket.

**Connected but no messages** — Check the group/private whitelist first and temporarily enable dropped-message logs.

**Connection failure** — Verify the host, port, and WebSocket token. In Docker, do not use `127.0.0.1` for the NapCat service.

**No reconnect after saving** — Check the plugin configuration-update log. Use a full MaiBot restart only as a fallback after hot reload fails.
