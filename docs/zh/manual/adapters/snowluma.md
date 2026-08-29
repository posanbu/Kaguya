---
title: SnowLuma 适配器
---
# SnowLuma 适配器

SnowLuma 适配器让 MaiBot 通过 [SnowLuma](https://github.com/Mai-with-u/MaiBot-SnowLuma-Adapter) 连接到 QQ 平台，收发消息、处理群聊和私聊。

::: warning 可用（测试中）
SnowLuma 适配器目前处于测试阶段，功能基本可用，但可能存在未覆盖的边界情况。如遇问题欢迎在 [GitHub Issues](https://github.com/Mai-with-u/MaiBot-SnowLuma-Adapter/issues) 反馈。
:::

## 简介

SnowLuma 适配器是一个 MaiBot 插件，通过 WebSocket 与 SnowLuma 进行双向通信。它的工作方式很简单：

- **入站**：SnowLuma 推送 QQ 消息到适配器，适配器转换后注入 MaiBot
- **出站**：MaiBot 生成的回复经适配器转换后，通过 SnowLuma 发送出去

与 NapCat 适配器不同，SnowLuma 适配器只有**插件模式**，不提供独立运行方式。适配器直接在 MaiBot 进程内运行，配置更少，部署更简单。

消息流转：**QQ → SnowLuma → 适配器插件（MaiBot 内部）→ MaiBot**

### 适配器仓库

SnowLuma 适配器的源码：[Mai-with-u/MaiBot-SnowLuma-Adapter](https://github.com/Mai-with-u/MaiBot-SnowLuma-Adapter)

## 安装

### 第一步：获取适配器

克隆适配器仓库到 MaiBot 的 `plugins/` 文件夹中：

::: code-group

```bash [Bash ~vscode-icons:file-type-shell~]
# 进入 MaiBot 的 plugins 目录
cd MaiBot/plugins

# 克隆仓库
git clone https://github.com/Mai-with-u/MaiBot-SnowLuma-Adapter.git
```

:::

或者，你也可以通过 MaiBot 的 WebUI 界面安装插件。

### 第二步：配置 SnowLuma 连接

适配器已经在 MaiBot 内部运行了，只需要配置适配器和 SnowLuma 之间的连接信息。编辑适配器的配置文件 `plugins/MaiBot-SnowLuma-Adapter/config.toml`，填写 SnowLuma 的地址和端口。

### 第三步：配置 SnowLuma

确保 SnowLuma 已启用正向 WebSocket 服务器，监听地址和端口需要与适配器配置中的 `luma_client.server` 和 `luma_client.port` 一致。

默认连接地址为 `ws://127.0.0.1:3001`，如果你的 SnowLuma 在同一台机器上运行，保持默认即可。

### 第四步：启动

直接启动 MaiBot 就行，适配器会自动加载并连接。

### 插件默认未启用

SnowLuma 适配器插件安装后**默认是禁用的**，需要手动启用才能连接。

#### 方式一：编辑配置文件（推荐）

编辑 `plugins/MaiBot-SnowLuma-Adapter/config.toml`，将 `enabled` 改为 `true`：

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[plugin]
enabled = true   # 改为 true
config_version = "1.0.0"
```

:::

然后重启 MaiBot 即可。

#### 方式二：通过 WebUI 启用

1. 浏览器访问 `http://127.0.0.1:8001`，输入 Access Token 登录
2. 点击左侧菜单 **"插件管理"**
3. 找到 **"SnowLuma 适配器"**，点击启用开关
4. 保存配置后重启 MaiBot（或等待插件热重载）

> **验证是否启用**：启动 MaiBot 后，查看日志中是否出现适配器加载和连接成功的提示；如果看到 `已在配置中禁用，跳过激活` 则说明未启用。

## 配置参考

适配器的配置文件位于 `plugins/MaiBot-SnowLuma-Adapter/config.toml`，包含以下四个分组。

### 插件设置 (`[plugin]`)

- **`enabled`** — 是否启用 SnowLuma 适配器。关闭时插件只注册消息网关，不会主动连接 SnowLuma。默认关闭
- **`config_version`** — 当前配置结构版本（自动管理，一般不需要手动修改）。默认 "1.0.0"

### SnowLuma 连接 (`[luma_client]`)

- **`server`** — SnowLuma WebSocket 服务地址。默认 "127.0.0.1"
- **`port`** — SnowLuma WebSocket 服务端口。默认 3001
- **`token`** — SnowLuma 访问令牌（可留空）。默认为空
- **`connection_id`** — 可选连接标识，用于区分多条适配器链路。默认为空
- **`reconnect_delay_sec`** — 连接断开后的重连等待时间（秒）。默认 5.0
- **`action_timeout_sec`** — 调用 SnowLuma 动作接口的超时时间（秒）。默认 10.0

### 聊天过滤 (`[chat]`)

- **`enable_chat_list_filter`** — 是否启用群聊与私聊名单过滤。关闭后仅保留 `ban_user_id` 规则。默认开启
- **`show_dropped_chat_list_messages`** — 是否记录未通过聊天名单过滤而被丢弃的消息。默认关闭
- **`group_list_type`** — 群聊名单模式。白名单只接收列表内群聊，黑名单则忽略列表内群聊。默认 "whitelist"
- **`group_list`** — 群聊名单中的群号列表（自动去重）。默认为空
- **`private_list_type`** — 私聊名单模式。白名单只接收列表内私聊，黑名单则忽略列表内私聊。默认 "whitelist"
- **`private_list`** — 私聊名单中的用户 ID 列表（自动去重）。默认为空
- **`ban_user_id`** — 全局屏蔽的用户 ID 列表，这些用户的消息会在进入 MaiBot 之前被直接丢弃。默认为空
- **`ban_qq_bot`** — 是否屏蔽 QQ 官方机器人消息。默认关闭

::: tip 群聊白名单默认开启
适配器默认启用聊天名单过滤，且群聊默认是白名单模式。意味着没有写进 `group_list` 的群消息会被直接丢弃。如果连接成功但群里 @ 机器人没有反应，优先检查这里。
:::

测试阶段可以临时关闭名单过滤：

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[chat]
enable_chat_list_filter = false
```

:::

或者把需要测试的群号加入白名单：

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[chat]
enable_chat_list_filter = true
group_list_type = "whitelist"
group_list = ["你的QQ群号"]
```

:::

### 消息过滤 (`[filters]`)

- **`ignore_self_message`** — 是否忽略机器人自身发送的消息（建议保持开启，避免机器人处理自己刚发出的消息）。默认开启

### 完整配置示例

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[plugin]
enabled = true
config_version = "1.0.0"

[luma_client]
server = "127.0.0.1"
port = 3001
token = ""
connection_id = ""
reconnect_delay_sec = 5.0
action_timeout_sec = 10.0

[chat]
enable_chat_list_filter = true
show_dropped_chat_list_messages = false
group_list_type = "whitelist"
group_list = ["123456789"]
private_list_type = "whitelist"
private_list = []
ban_user_id = []
ban_qq_bot = false

[filters]
ignore_self_message = true
```

:::

## 验证与排查

### 验证连接

怎么知道连上了？看这几个地方：

1. **WebUI 插件列表**：能看到 SnowLuma 适配器插件已加载
2. **MaiBot 日志**：看到 `SnowLuma WebSocket 已连接` 的提示
3. **发消息测试**：在 QQ 群里 @机器人，看有没有回复

### 连不上怎么办？

**检查这几点**：

- SnowLuma 的地址和端口填对了吗？和适配器 `luma_client.server` / `luma_client.port` 一致吗？
- 防火墙拦住了吗？
- SnowLuma 和 MaiBot 在同一台机器吗？
- 访问令牌 `token` 填对了吗？
- 日志里有什么报错信息？

### 收不到消息？

**可能原因**：

- 群聊白名单默认开启，你的群号加入 `group_list` 了吗？
- `enabled` 设为 `true` 了吗？
- SnowLuma 本身收到消息了吗？看 SnowLuma 的日志
- 网络连接正常吗？

### 发不出消息？

**排查方法**：

- 机器人有发言权限吗？（群聊需要权限）
- 看 MaiBot 日志有什么报错
- `action_timeout_sec` 设置是否合理？网络延迟较高时可以适当增大

### 多实例部署

如果需要同一个 MaiBot 对接多个 SnowLuma 实例（比如多个 QQ 号），可以为每个实例配置不同的 `connection_id` 来区分链路：

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[luma_client]
connection_id = "bot-1"
```

:::