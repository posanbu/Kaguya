---
title: Telegram 适配器
---
# Telegram 适配器

MaiBot 的 Telegram 平台适配器，通过 Telegram Bot API 长轮询将 Telegram Bot 与 MaiBot 无缝桥接。

## 适配器仓库

Telegram 适配器的源码：[exynos967/MaiBot-Telegram-Adapter](https://github.com/exynos967/MaiBot-Telegram-Adapter)

## 创建 Telegram Bot

在使用适配器之前，你需要先在 Telegram 上创建一个 Bot 并获取 Token。

### 第一步：通过 @BotFather 创建 Bot

1. 在 Telegram 中搜索 [@BotFather](https://t.me/BotFather)
2. 发送 `/newbot`，按照提示输入 Bot 名称和用户名
3. 创建完成后，BotFather 会返回 Bot Token，格式类似 `123456:ABC-DEF...`
4. 将此 Token 填入适配器配置的 `telegram_bot.token` 字段

### 第二步：关闭 Privacy Mode

默认情况下，Telegram Bot 在群聊中只能接收以 `/` 开头的命令和直接 @Bot 的消息。如果需要 Bot 在群聊中接收所有消息，必须关闭 Privacy Mode：

1. 向 @BotFather 发送 `/setprivacy`
2. 选择你创建的 Bot
3. 选择 **Disable**

关闭 Privacy Mode 后，Bot 将能接收群聊中的所有消息。如果想通过 @Bot 或回复来触发机器人，也建议关闭此项以确保消息能被正常接收。

## 安装

将适配器仓库克隆到 MaiBot 的 `plugins/` 目录下：

::: code-group

```bash [Bash ~vscode-icons:file-type-shell~]
cd /path/to/MaiBot/plugins
git clone https://github.com/exynos967/MaiBot-Telegram-Adapter.git
```

:::

### 依赖

- `maibot_sdk` >= 2.0.0（由 MaiBot 主程序提供）
- `aiohttp` >= 3.9.0（MaiBot 主程序已包含）

如需 SOCKS5 代理支持，额外安装：

::: code-group

```bash [Bash ~vscode-icons:file-type-shell~]
pip install aiohttp-socks
```

:::

## 配置

### 适配器配置

首次加载后，适配器会在插件目录生成 `config.toml`，编辑该文件：

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
配置也可以通过 MaiBot WebUI 的插件配置页面进行热重载修改，无需重启 MaiBot。
:::

### MaiBot 主配置

MaiBot Core 需要通过主配置里的 `platforms` 字段识别"机器人自己"。启用 Telegram 后，请在 MaiBot 主配置的 `[bot]` 中加入 Telegram Bot 的数字 ID：

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[bot]
platforms = ["telegram:123456789"]
```

:::

其中 `123456789` 是你的 Telegram Bot 的数字 ID，也可以使用简写 `tg:123456789`。Bot 数字 ID 会在适配器启动成功后通过日志 `Telegram Bot: id=...` 输出。

::: warning 注意
如果缺少 `platforms` 中的 Telegram 配置，MaiBot 的历史消息和提示词中可能无法将 Bot 自身识别为配置的昵称。
:::

## 配置参考

### `[plugin]` — 插件设置

- **`enabled`** — 是否启用 Telegram 适配器。关闭后插件保持空闲，不会启动轮询。默认关闭
- **`config_version`** — 当前配置结构版本（自动维护，无需手动修改）。默认 "0.1.0"

### `[telegram_bot]` — Telegram Bot 连接配置

- **`token`** — Bot Token，从 @BotFather 获取。启用适配器时必填。默认为空
- **`api_base`** — Telegram Bot API 基础地址。使用自建 API 服务器时可修改此项。默认 "https://api.telegram.org"
- **`poll_timeout`** — 长轮询超时时间（秒）。增大此值可减少请求频率，但会增加消息延迟感知。默认 20
- **`proxy_enabled`** — 是否启用代理。默认关闭
- **`proxy_url`** — 代理地址，支持 `http://`、`https://` 和 `socks5://` 协议。例如 `http://127.0.0.1:7890` 或 `socks5://127.0.0.1:1080`。默认为空
- **`proxy_from_env`** — 是否从环境变量（如 `HTTP_PROXY`、`HTTPS_PROXY`）读取代理设置。默认关闭

### `[chat]` — 聊天过滤

- **`group_list_type`** — 群聊名单模式，可选 `whitelist`（白名单）或 `blacklist`（黑名单）。默认 "whitelist"
- **`group_list`** — 群聊名单中的 chat_id 列表。默认为空
- **`private_list_type`** — 私聊名单模式，可选 `whitelist`（白名单）或 `blacklist`（黑名单）。默认 "whitelist"
- **`private_list`** — 私聊名单中的用户 ID 列表。默认为空
- **`ban_user_id`** — 全局屏蔽的用户 ID 列表，被屏蔽用户的消息会被直接丢弃。默认为空

::: tip 聊天过滤说明
- **白名单模式**：只处理名单中的群聊/私聊消息，其余丢弃
- **黑名单模式**：处理所有消息，但丢弃名单中的群聊/私聊消息
- 默认群聊为白名单模式，如果发现 Bot 已连接但群里没有反应，优先检查 `group_list` 是否填写了对应的 chat_id
:::

## 消息类型支持

- **文本** — 入站：支持 | 出站：支持
- **图片** — 入站：支持（自动下载转 base64） | 出站：支持（base64 / URL）
- **语音** — 入站：支持（自动下载转 base64） | 出站：支持（base64）
- **贴纸** — 入站：支持（转 emoji 类型） | 出站：支持（以动图发送）
- **GIF 动图** — 入站：支持（转 emoji 类型） | 出站：支持（以动图发送）
- **视频** — 入站：不支持 | 出站：支持（URL）
- **文件** — 入站：支持（转文本标记） | 出站：支持（URL）
- **回复消息** — 入站：支持（关联消息 ID） | 出站：支持（reply_parameters）
- **@Bot** — 入站：支持（多种识别方式）

## 代理配置

如果服务器无法直接访问 Telegram API，可以通过代理连接。适配器支持以下代理方式：

### HTTP/HTTPS 代理

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[telegram_bot]
proxy_enabled = true
proxy_url = "http://127.0.0.1:7890"
```

:::

### SOCKS5 代理

使用 SOCKS5 代理需要额外安装 `aiohttp-socks` 依赖：

::: code-group

```bash [Bash ~vscode-icons:file-type-shell~]
pip install aiohttp-socks
```

:::

然后配置：

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[telegram_bot]
proxy_enabled = true
proxy_url = "socks5://127.0.0.1:1080"
```

:::

### 从环境变量读取代理

如果系统已配置 `HTTP_PROXY` 或 `HTTPS_PROXY` 环境变量，可以启用此选项：

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[telegram_bot]
proxy_enabled = true
proxy_from_env = true
```

:::

### 自定义 API 地址

如果使用自建的 Telegram API 代理服务器（如 Telegram Bot API Server），可以修改 `api_base`：

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[telegram_bot]
api_base = "https://your-api-server.com"
```

:::

## Topic 分流

Telegram 超级群组支持 Topic（话题）功能。适配器会自动将同一群组中不同 Topic 的消息分流为独立的会话，使 MaiBot 在各 Topic 中维护独立的上下文。

具体机制：

- 入站时，适配器将 `chat_id` 和 `message_thread_id` 组合为虚拟的 `group_id`（格式：`chat_id::tg-topic::mt=thread_id`）
- 出站时，适配器解析虚拟 `group_id`，将消息发送到正确的 Topic
- 这样，同一个 Telegram 群组的不同 Topic 在 MaiBot 中被视为不同的群组，各自拥有独立的对话上下文

## @Bot 识别机制

适配器支持多种方式识别用户 @Bot 的行为，确保机器人在群聊中能被正确触发：

1. **mention entity**：Telegram 消息的 `entities` 中包含 `mention` 或 `text_mention` 类型，且指向 Bot
2. **回复 Bot**：用户回复了 Bot 发送的消息（`reply_to_message` 的发送者是 Bot）
3. **文本兜底匹配**：当以上方式均未匹配时，通过正则匹配消息文本中的 `@bot_username`

当识别到 @Bot 时，适配器会：
- 在消息段中插入 `at` 类型的组件，标记 `target_user_id` 为 Bot ID
- 设置 `is_mentioned` 和 `is_at` 为 `true`
- 移除文本开头重复的 `@bot_username` 文本，避免 Prompt 中出现两份 @

## 验证连接

启动 MaiBot 后，检查以下内容确认适配器工作正常：

1. **MaiBot 日志**：看到 `Telegram Bot: id=xxx, username=xxx` 输出，说明 Bot 身份获取成功
2. **MaiBot 日志**：看到 `Telegram 适配器开始轮询...`，说明已开始接收消息
3. **发消息测试**：在 Telegram 中向 Bot 发送私聊消息或在群聊中 @Bot，看是否有回复

### 常见问题

**Bot 启动后没有开始轮询**

- 检查 `plugin.enabled` 是否设为 `true`
- 检查 `telegram_bot.token` 是否填写正确
- 查看日志中是否有 `telegram_bot.token 为空` 的警告

**群聊中收不到消息**

- 确认已关闭 Bot 的 Privacy Mode（参见[关闭 Privacy Mode](#第二步-关闭-privacy-mode)）
- 检查 `chat.group_list` 是否包含目标群聊的 chat_id
- 检查 `chat.group_list_type` 的模式是否正确

**无法连接 Telegram API**

- 检查网络是否能访问 `api.telegram.org`
- 如果在中国大陆，需要配置代理（参见[代理配置](#代理配置)）
- 检查代理地址格式是否正确