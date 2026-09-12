---
title: 使用 NapCat 适配器连接 QQ
---

# 使用 NapCat 适配器连接 QQ

当前 NapCat 适配器是 MaiBot 插件。NapCat 提供 **正向 WebSocket（WebSocket 服务器）**，适配器作为客户端主动连接 NapCat，再通过插件消息网关把消息交给 MaiBot。

::: info 连接方向
`NapCat WebSocket 服务器 ← NapCat 适配器客户端 → MaiBot 插件消息网关`

插件版不使用 `[maim_message]`，也不需要在 NapCat 中配置“反向 WebSocket”。
:::

适配器源码：[Mai-with-u/MaiBot-Napcat-Adapter](https://github.com/Mai-with-u/MaiBot-Napcat-Adapter)

## 1. 安装并登录 NapCat

按照 [NapCat 官方文档](https://napneko.github.io/guide/boot/Shell) 安装 NapCat，并登录用于机器人的 QQ 小号。

## 2. 开启正向 WebSocket 服务器

在 NapCat WebUI 的网络配置中：

1. 新建或启用 **正向 WebSocket / WebSocket 服务器**。
2. 设置监听地址和端口，常用端口为 `3001`。
3. 可以设置访问 Token；如果设置了，稍后把同一个 Token 填入适配器。

不要把 NapCat WebUI Token、MaiBot WebUI Access Token 和 WebSocket Token 混用。

## 3. 配置 MaiBot 的机器人账号

在 WebUI 基础配置中填写平台和 QQ 账号，或编辑 `config/bot_config.toml`：

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[bot]
platform = "qq"
qq_account = "123456789"
```

:::

`qq_account` 必须与 NapCat 实际登录的 QQ 号一致。NapCat 用该账号登录 QQ；MaiBot 核心用这个配置识别机器人自己发送的消息。插件版虽然不使用 `[maim_message]`，但仍然需要 `[bot].qq_account`。

## 4. 安装并启用适配器

在 MaiBot WebUI 中打开“插件管理”，从插件市场安装 **NapCat Adapter**，然后手动启用。插件默认配置为禁用，安装成功不等于已经运行。

如果插件市场不可用，也可以把仓库克隆到 MaiBot 的 `plugins/` 目录：

::: code-group

```bash [Bash ~vscode-icons:file-type-shell~]
git clone https://github.com/Mai-with-u/MaiBot-Napcat-Adapter.git plugins/MaiBot-Napcat-Adapter
```

:::

手动克隆后仍建议在 WebUI 中完成启用和配置。插件目录名可能因安装方式而异，不要依赖固定目录名判断是否安装成功。

## 5. 配置连接

在 NapCat Adapter 的插件设置中填写：

**`napcat_server.host`** — NapCat 的地址。同机运行填 `127.0.0.1`；使用项目 Docker Compose 时填服务名 `napcat`。

**`napcat_server.port`** — NapCat 正向 WebSocket 的监听端口，例如 `3001`。

**`napcat_server.token`** — NapCat 正向 WebSocket 的访问 Token；未设置则留空。

适配器会连接类似 `ws://127.0.0.1:3001` 的地址。保存配置后，插件的 `on_config_update` 会停止旧连接并按新配置重新连接，通常不需要重启 MaiBot。

## 6. 配置聊天名单

适配器默认启用聊天名单过滤，群聊与私聊均默认为白名单，初始名单为空。未加入名单的消息会被丢弃。

测试时可在插件设置中临时关闭名单过滤；正式使用建议保留过滤并把允许的群号或 QQ 号加入对应名单。例如：

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[chat]
enable_chat_list_filter = true
show_dropped_chat_list_messages = true
group_list_type = "whitelist"
group_list = ["你的QQ群号"]
```

:::

## 验证与排错

**确认插件已加载** — WebUI 插件列表显示 NapCat Adapter 已启用，MaiBot 日志没有加载错误。

**确认连接方向** — NapCat 运行的是 WebSocket 服务器，适配器日志显示已连接到 NapCat；不要配置反向 WebSocket。

**已连接但不收消息** — 首先检查群聊或私聊白名单，并临时打开丢弃消息日志。

**连接失败** — 核对地址、端口和 WebSocket Token。Docker 中不要把 NapCat 地址写成 `127.0.0.1`。

**改配置后没有重连** — 查看插件配置更新日志；只有热更新回调失败时，才把完整重启 MaiBot 作为兜底。
