---
title: Telegram Adapter
---

# Telegram Adapter

The Telegram platform adapter for MaiBot, which seamlessly bridges a Telegram Bot with MaiBot via Telegram Bot API long polling.

## Adapter Repository

Source code for the Telegram adapter: [exynos967/MaiBot-Telegram-Adapter](https://github.com/exynos967/MaiBot-Telegram-Adapter)

## Creating a Telegram Bot

Before using the adapter, you need to create a Bot on Telegram and obtain a Token.

### Step 1: Create a Bot via @BotFather

1. Search for [@BotFather](https://t.me/BotFather) in Telegram.
2. Send `/newbot` and follow the prompts to enter the Bot name and username.
3. Once created, BotFather will return a Bot Token, formatted like `123456:ABC-DEF...`.
4. Enter this Token into the `telegram_bot.token` field of the adapter configuration.

### Step 2: Disable Privacy Mode

By default, Telegram Bots in group chats can only receive commands starting with `/` and messages that directly @mention the Bot. If you want the Bot to receive all messages in group chats, you must disable Privacy Mode:

1. Send `/setprivacy` to @BotFather.
2. Select the Bot you created.
3. Select **Disable**.

After disabling Privacy Mode, the Bot will be able to receive all messages in group chats. If you wish to trigger the bot via @mention or replies, it is also recommended to disable this setting to ensure messages are received normally.

## Installation

Clone the adapter repository into the `plugins/` directory of MaiBot:

::: code-group

```bash [Bash ~vscode-icons:file-type-shell~]
cd /path/to/MaiBot/plugins
git clone https://github.com/exynos967/MaiBot-Telegram-Adapter.git
```

:::

### Dependencies

- `maibot_sdk` >= 2.0.0 (provided by the MaiBot main program)
- `aiohttp` >= 3.9.0 (included in the MaiBot main program)

For SOCKS5 proxy support, install additionally:

::: code-group

```bash [Bash ~vscode-icons:file-type-shell~]
pip install aiohttp-socks
```

:::

## Configuration

### Adapter Configuration

After the first load, the adapter will generate `config.toml` in the plugin directory. Edit this file:

```toml
[plugin]
enabled = true                # 启用插件
config_version = "0.1.0"

[telegram_bot]
token = "你的Bot Token"       # 必填，从 @BotFather 获取
api_base = "https://api.telegram.org"
poll_timeout = 20
proxy_enabled = false
proxy_url = ""                # 例如 socks5://127.0.0.1:1080 或 http://127.0.0.1:7890
proxy_from_env = false

[chat]
group_list_type = "whitelist" # whitelist / blacklist
group_list = []               # chat_id 列表
private_list_type = "whitelist"
private_list = []             # 用户 ID 列表
ban_user_id = []              # 全局屏蔽用户
```

::: tip 提示
Configuration can also be modified via hot-reload on the plugin configuration page of the MaiBot WebUI without restarting MaiBot.
:::

### MaiBot Main Configuration

MaiBot Core needs to identify "the bot itself" via the `platforms` field in the main configuration. After enabling Telegram, please add the Telegram Bot's numeric ID to the `[bot]` of the MaiBot main configuration:

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[bot]
platforms = ["telegram:123456789"]
```

:::

Where `123456789` is your Telegram Bot's numeric ID; you can also use the shorthand `tg:123456789`. The Bot's numeric ID will be output in the logs as `Telegram Bot: id=...` after the adapter starts successfully.

::: warning 注意
If the Telegram configuration in `platforms` is missing, MaiBot may be unable to identify the Bot itself as the configured nickname in historical messages and prompts.
:::

## Configuration Reference

### `[plugin]` — Plugin Settings

- **`enabled`** — Whether to enable the Telegram adapter. When disabled, the plugin remains idle and will not start polling. Default: disabled.
- **`config_version`** — Current configuration structure version (automatically maintained, no manual modification needed). Default: "0.1.0"

### `[telegram_bot]` — Telegram Bot Connection Configuration

- **`token`** — Bot Token, obtained from @BotFather. Required when enabling the adapter. Default: empty.
- **`api_base`** — Telegram Bot API base URL. This can be modified when using a self-hosted API server. Default: "https://api.telegram.org"
- **`poll_timeout`** — Long polling timeout (seconds). Increasing this value can reduce request frequency but will increase perceived message latency. Default: 20
- **`proxy_enabled`** — Whether to enable proxy. Default: disabled.
- **`proxy_url`** — Proxy address, supporting `http://`, `https://`, and `socks5://` protocols. For example, `http://127.0.0.1:7890` or `socks5://127.0.0.1:1080`. Default: empty.
- **`proxy_from_env`** — Whether to read proxy settings from environment variables (e.g., `HTTP_PROXY`, `HTTPS_PROXY`). Default: disabled.

### `[chat]` — Chat Filtering

- **`group_list_type`** — Group chat list mode, either `whitelist` (whitelist) or `blacklist` (blacklist). Default: "whitelist"
- **`group_list`** — List of chat_ids in the group chat list. Default: empty.
- **`private_list_type`** — Private chat list mode, either `whitelist` (whitelist) or `blacklist` (blacklist). Default: "whitelist"
- **`private_list`** — List of user IDs in the private chat list. Default: empty.
- **`ban_user_id`** — Global blocked user ID list; messages from blocked users will be discarded directly. Default: empty.

::: tip 聊天过滤说明
- **Whitelist Mode**: Only process group/private chat messages in the list; others are discarded.
- **Blacklist Mode**: Process all messages, but discard group/private chat messages in the list.
- Group chats are whitelist mode by default. If the Bot is connected but unresponsive in a group, first check if the corresponding chat_id is filled in `group_list`.
:::

## Message Type Support

- **Text** — Inbound: Supported | Outbound: Supported
- **Image** — Inbound: Supported (auto-download to base64) | Outbound: Supported (base64 / URL)
- **Voice** — Inbound: Supported (auto-download to base64) | Outbound: Supported (base64)
- **Sticker** — Inbound: Supported (converted to emoji type) | Outbound: Supported (sent as animation)
- **GIF** — Inbound: Supported (converted to emoji type) | Outbound: Supported (sent as animation)
- **Video** — Inbound: Not Supported | Outbound: Supported (URL)
- **File** — Inbound: Supported (converted to text marker) | Outbound: Supported (URL)
- **Reply Message** — Inbound: Supported (associated message ID) | Outbound: Supported (reply_parameters)
- **@Bot** — Inbound: Supported (multiple identification methods)

## Proxy Configuration

If the server cannot directly access the Telegram API, it can connect via a proxy. The adapter supports the following proxy methods:

### HTTP/HTTPS Proxy

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[telegram_bot]
proxy_enabled = true
proxy_url = "http://127.0.0.1:7890"
```

:::

### SOCKS5 Proxy

Using a SOCKS5 proxy requires the additional installation of the `aiohttp-socks` dependency:

::: code-group

```bash [Bash ~vscode-icons:file-type-shell~]
pip install aiohttp-socks
```

:::

Then configure:

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[telegram_bot]
proxy_enabled = true
proxy_url = "socks5://127.0.0.1:1080"
```

:::

### Read Proxy from Environment Variables

If `HTTP_PROXY` or `HTTPS_PROXY` environment variables are already configured in the system, you can enable this option:

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[telegram_bot]
proxy_enabled = true
proxy_from_env = true
```

:::

### Custom API Address

If using a self-hosted Telegram API proxy server (such as Telegram Bot API Server), you can modify `api_base`:

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[telegram_bot]
api_base = "https://your-api-server.com"
```

:::

## Topic Routing

Telegram Supergroups support the Topic feature. The adapter automatically routes messages from different Topics within the same group into independent sessions, allowing MaiBot to maintain separate contexts for each Topic.

Specific mechanism:

- On inbound, the adapter combines `chat_id` and `message_thread_id` into a virtual `group_id` (format: `chat_id::tg-topic::mt=thread_id`)
- On outbound, the adapter parses the virtual `group_id` and sends the message to the correct Topic
- This way, different Topics in the same Telegram group are treated as different groups in MaiBot, each with its own independent conversation context.

## @Bot Identification Mechanism

The adapter supports multiple ways to identify when a user @mentions the Bot, ensuring the bot is correctly triggered in group chats:

1. **Mention Entity**: The `entities` of the Telegram message contains a `mention` or `text_mention` type pointing to the Bot.
2. **Reply to Bot**: The user replied to a message sent by the Bot (the sender of `reply_to_message` is the Bot).
3. **Text Fallback Matching**: When the above methods fail, it uses regex to match `@bot_username` within the message text.

When an @Bot mention is identified, the adapter will:
- Insert a component of type `at` into the message segment, marking `target_user_id` as the Bot ID.
- Set `is_mentioned` and `is_at` to `true`.
- Remove duplicate `@bot_username` text from the beginning of the text to avoid having two @mentions in the Prompt.

## Verifying Connection

After starting MaiBot, check the following to confirm the adapter is working correctly:

1. **MaiBot Logs**: Seeing `Telegram Bot: id=xxx, username=xxx` output indicates the Bot identity was successfully retrieved.
2. **MaiBot Logs**: Seeing `Telegram 适配器开始轮询...` indicates it has started receiving messages.
3. **Message Test**: Send a private message to the Bot in Telegram or @mention the Bot in a group chat to see if there is a response.

### FAQ

**Bot is started but not polling**

- Check if `plugin.enabled` is set to `true`.
- Check if `telegram_bot.token` is filled in correctly.
- Check the logs for `telegram_bot.token 为空` warnings.

**Not receiving messages in group chats**

- Confirm that the Bot's Privacy Mode has been disabled (see [Disable Privacy Mode](#step-2-disable-privacy-mode)).
- Check if `chat.group_list` contains the target group's chat_id.
- Check if the mode of `chat.group_list_type` is correct.

**Unable to connect to Telegram API**

- Check if the network can access `api.telegram.org`.
- If in Mainland China, a proxy must be configured (see [Proxy Configuration](#proxy-configuration)).
- Check if the proxy address format is correct.
