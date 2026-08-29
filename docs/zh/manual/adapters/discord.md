---
title: Discord 适配器
---
# Discord 适配器

MaiBot 的 Discord 平台适配器插件，通过 Discord Gateway WebSocket 将 Discord Bot 与 MaiBot 无缝桥接，支持 Guild 频道、DM 私聊、Thread 子区、Reaction 及语音功能。

## 适配器仓库

Discord 适配器源码：[litroenade/MaiBot-Discord-Adapter](https://github.com/litroenade/MaiBot-Discord-Adapter)

## 创建 Discord Bot

在使用适配器之前，你需要先在 Discord 上创建一个 Bot 并获取 Token。

### 第一步：创建应用和 Bot

1. 访问 [Discord Developer Portal](https://discord.com/developers/applications)
2. 点击右上角 **New Application**，输入应用名称并创建
3. 在左侧导航栏点击 **Bot**
4. 点击 **Reset Token**（或 **Add Bot**），复制 Bot Token 并妥善保存

### 第二步：启用 Privileged Gateway Intents

在 Bot 页面向下滚动到 **Privileged Gateway Intents** 区域，启用以下 Intent：

- **Message Content Intent**（必须）— 不启用则无法读取消息内容
- **Presence Intent**（可选）— 需要监听用户在线状态时启用
- **Server Members Intent**（可选）— 需要获取完整成员列表时启用

::: warning 注意
如果不启用 **Message Content Intent**，Bot 将无法读取消息文本内容，`connection.intent_message_content` 即便设为 `true` 也不会生效。
:::

### 第三步：邀请 Bot 到服务器

1. 在左侧导航栏点击 **OAuth2**
2. 在 **OAuth2 URL Generator** 中选择：
   - **Scopes**：勾选 `bot`
   - **Bot Permissions**：根据需要勾选以下权限：
     - Send Messages — 发送消息
     - Read Message History — 读取消息历史（回复引用必需）
     - View Channels — 查看频道
     - Add Reactions — 添加表情反应
     - Connect — 连接语音频道（语音功能必需）
     - Speak — 在语音频道说话（语音功能必需）
     - Attach Files — 发送附件/图片
3. 复制生成的邀请链接，在浏览器中打开并选择你的服务器完成邀请

::: tip 权限建议
如果需要使用语音功能，Bot 对目标语音频道还需要拥有 `View Channel`、`Connect`、`Speak` 权限，否则无法加入和播放语音。
:::

### 第四步：获取服务器/频道 ID

配置聊天过滤需要用到服务器 ID 和频道 ID。在 Discord 中启用开发者模式：

1. 打开 Discord 设置 -> 高级 -> 开启 **开发者模式**
2. 右键服务器图标 -> 复制服务器 ID
3. 右键频道名 -> 复制频道 ID

## 安装

将适配器仓库克隆到 MaiBot 的 `plugins/` 目录下：

::: code-group

```bash [Bash ~vscode-icons:file-type-shell~]
cd /path/to/MaiBot/plugins
git clone https://github.com/litroenade/MaiBot-Discord-Adapter.git
```

:::

也可以通过 MaiBot 的 WebUI 界面安装插件。

### 依赖

- `maibot_sdk` >= 2.0.0（由 MaiBot 主程序提供）
- `discord.py` >= 2.3.0
- `discord-ext-voice-recv` >= 0.4.1a139（语音功能需要）
- `PyNaCl` >= 1.5.0（语音功能需要）

语音相关的依赖会在启用语音功能时自动安装。如果只做纯文本收发，无需额外安装。

## 配置

### 启用适配器

适配器安装后**默认是禁用的**，需要手动启用。

#### 方式一：编辑配置文件

编辑 `plugins/MaiBot-Discord-Adapter/config.toml`，将 `enabled` 改为 `true` 并填写 Bot Token：

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[plugin]
enabled = true                # 启用适配器
config_version = "1.0.0"

[connection]
token = "你的Discord Bot Token"  # 必填
```

:::

然后重启 MaiBot 即可。

#### 方式二：通过 WebUI 启用

1. 浏览器访问 MaiBot WebUI，输入 Access Token 登录
2. 点击左侧菜单 **"插件管理"**
3. 找到 **"Discord 适配器"**，点击启用开关
4. 在配置中填写 `connection.token`
5. 保存配置后重启 MaiBot（或等待插件热重载）

::: tip 提示
配置也可以通过 WebUI 的插件配置页面进行热重载修改，无需重启 MaiBot。
:::

### 聊天过滤说明

适配器默认启用聊天名单过滤，名单模式默认为**黑名单**（即允许所有来源）。如果需要限制 Bot 只响应特定服务器或频道，可以将模式改为白名单并填写对应 ID：

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[chat]
guild_list_type = "whitelist"
guild_list = ["你的服务器ID"]
channel_list_type = "whitelist"
channel_list = ["你的频道ID"]
```

:::

如果发现 Bot 已连接但消息没有反应，优先检查聊天过滤配置。

## 配置参考

### `[plugin]` — 插件设置

- **`enabled`** — 是否启用 Discord 适配器。关闭后插件保持空闲，不会建立 Discord 连接。默认关闭
- **`config_version`** — 当前配置结构版本（自动维护，无需手动修改）。默认 "1.0.0"

### `[connection]` — Discord 连接

- **`token`** — Discord Bot Token，在 Developer Portal 的 Bot 页面复制。启用适配器时必填。默认为空
- **`intent_messages`** — 服务器消息权限（Guild Messages），控制服务器内频道/子区消息。默认开启
- **`intent_guilds`** — 服务器权限（获取服务器信息）。默认开启
- **`intent_dm_messages`** — 私信消息权限（Direct Messages），控制私聊消息。默认开启
- **`intent_message_content`** — 消息内容权限，必须启用，否则无法读取消息内容。默认开启
- **`intent_voice_states`** — 语音状态权限，语音功能必须启用；只做纯文本收发时可以关闭。默认关闭
- **`retry_delay`** — 断线重试间隔（秒）。默认 5
- **`connection_check_interval`** — 连接状态检查间隔（秒，建议 30 秒以上）。默认 30

### `[chat]` — 聊天过滤

- **`guild_list_type`** — 服务器名单模式，可选 `whitelist`（白名单）或 `blacklist`（黑名单）。默认 "blacklist"
- **`guild_list`** — 服务器 ID 名单。默认为空
- **`channel_list_type`** — 频道名单模式。默认 "blacklist"
- **`channel_list`** — 频道 ID 名单。默认为空
- **`thread_list_type`** — 子区名单模式（继承频道权限时此项无效）。默认 "blacklist"
- **`thread_list`** — 子区 ID 名单。默认为空
- **`user_list_type`** — 用户名单模式。默认 "blacklist"
- **`user_list`** — 用户 ID 名单。默认为空
- **`allow_thread_interaction`** — 是否允许在子区（Thread）中互动。默认开启
- **`inherit_channel_permissions`** — 子区是否继承父频道权限。开启后父频道允许则子区允许，子区名单将被忽略。默认开启
- **`inherit_channel_memory`** — 子区是否继承父频道记忆。开启后子区与父频道共享上下文记忆；关闭则各自独立。默认开启
- **`show_typing_indicator`** — 收到可处理消息后是否先显示 Discord 的"正在输入"状态。默认开启
- **`typing_indicator_delay_ms`** — 显示"正在输入"前的延迟时间（毫秒），避免极快回复也闪一下。默认 0
- **`typing_indicator_timeout_sec`** — "正在输入"状态的最长保持时间（秒），设为 0 表示直到回复发出前都不主动超时。默认 0

::: tip 聊天过滤说明
- **白名单模式**：只处理名单中的服务器/频道/用户消息，其余丢弃
- **黑名单模式**：处理所有消息，但丢弃名单中的服务器/频道/用户消息
- 默认所有名单模式均为黑名单（即允许所有），如果发现 Bot 已连接但没有反应，优先检查名单配置
:::

### `[platform]` — 平台设置

- **`platform_name`** — 平台标识符，用于在 MaiBot 中区分不同的 Discord 实例。多实例运行时需唯一。默认 "discord"

### `[filters]` — 消息过滤

- **`ignore_self_message`** — 是否忽略机器人自身发送的消息。建议保持开启，避免机器人处理自己发出的消息。默认开启
- **`ignore_bot_message`** — 是否忽略其他机器人发送的消息。默认开启

### `[voice]` — 语音功能

- **`enabled`** — 是否启用语音功能。关闭时不会创建语音管理器，也不会主动加入任何语音频道。默认关闭
- **`voice_mode`** — 语音频道模式：`fixed` 常驻指定频道，`auto` 有人进入时自动加入、无人时退出。默认 "auto"
- **`fixed_channel_id`** — 固定模式下的语音频道 ID（填写语音频道而非频道分类的 ID）。默认为空
- **`auto_channel_list`** — 自动模式下的候选语音频道 ID 列表，只会在这里列出的语音频道里自动进出。默认为空
- **`idle_timeout_sec`** — 自动模式下无人后等待退出的秒数。默认 300
- **`tts_provider`** — TTS 语音合成服务商，可选 `siliconflow` / `gptsovits` / `minimax`。默认 "siliconflow"
- **`stt_provider`** — STT 语音识别服务商，可选 `siliconflow_sensevoice` / `aliyun` / `tencent`。默认 "siliconflow_sensevoice"
- **`enable_vad`** — 是否启用基于音量的语音活动检测（VAD）。默认开启
- **`vad_threshold_db`** — VAD 音量阈值（dB），高于此值视为正在说话。范围约 -60（灵敏）到 -30（严格）。默认 -50.0
- **`vad_deactivation_delay_ms`** — VAD 关闭延迟（毫秒），低于阈值后等待此时长才判定停止说话，避免断句。默认 500
- **`send_text_in_voice`** — TTS 播报时是否同时发送文字到语音频道文字区域（调试用）。默认关闭

::: warning 语音前置条件
启用语音功能需要同时满足以下条件：

- `voice.enabled = true`
- `connection.intent_voice_states = true`
- Bot 对目标语音频道拥有 `View Channel`、`Connect`、`Speak` 权限
:::

### `[siliconflow_tts]` — SiliconFlow TTS

当 `voice.tts_provider` 设为 `siliconflow` 时生效。

- **`api_key`** — SiliconFlow API 密钥。默认为空
- **`api_base`** — SiliconFlow API 地址。默认 "https://api.siliconflow.cn/v1"
- **`model`** — TTS 模型标识。默认 "fnlp/MOSS-TTSD-v0.5"
- **`voice`** — TTS 音色标识。默认 "fnlp/MOSS-TTSD-v0.5:alex"
- **`sample_rate`** — 音频采样率。opus 仅支持 48000；wav/pcm 支持 8000/16000/24000/32000/44100；mp3 支持 32000/44100。默认 32000
- **`speed`** — 语速（0.1 ~ 2.0）。默认 1.0
- **`response_format`** — 音频返回格式（mp3/opus/wav/pcm），推荐默认使用 wav。默认 "wav"

### `[gptsovits_tts]` — GPT-SoVITS TTS

当 `voice.tts_provider` 设为 `gptsovits` 时生效。

- **`api_base`** — GPT-SoVITS API 地址。默认 "http://127.0.0.1:8000"
- **`version`** — GPT-SoVITS 服务版本号。默认 "v4"
- **`model`** — 模板模型名，用于 infer_single 模板模型接口。配置页会优先从本地 GSV 拉取模板模型供选择。默认为空
- **`voice`** — 模板情感/音色（可选），留空则自动选择。默认为空
- **`text_lang`** — 合成语言代码。默认 "zh"
- **`response_format`** — 期望的音频格式，推荐 wav。默认 "wav"
- **`speed_factor`** — 语速因子。默认 1.0

::: tip 关于模板模型
配置页会优先从本地 GPT-SoVITS 服务的 `/models/{version}` 接口拉取模板模型列表供选择。如果拉取失败，也可以手动填写。不要填写 `GSVI-v4` 这类 OpenAI 兼容模型 ID。
:::

### `[minimax_tts]` — MiniMax TTS

当 `voice.tts_provider` 设为 `minimax` 时生效。

- **`api_key`** — MiniMax API 密钥。默认为空
- **`api_base`** — MiniMax API 地址。默认 "https://api.minimax.io"
- **`model`** — TTS 模型。默认 "speech-2.8-hd"
- **`voice_id`** — 音色 ID。默认 "male-qn-qingse"
- **`speed`** — 语速（0.5 ~ 2.0）。默认 1.0
- **`vol`** — 音量（0.1 ~ 2.0）。默认 1.0
- **`pitch`** — 音调偏移（-12 ~ 12）。默认 0.0
- **`audio_sample_rate`** — 输出采样率，可选值 8000/16000/22050/24000/32000/44100。默认 32000
- **`output_format`** — 音频编码格式（pcm/mp3/flac/wav）。默认 "mp3"

### `[siliconflow_stt]` — SiliconFlow STT

当 `voice.stt_provider` 设为 `siliconflow_sensevoice` 时生效。

- **`api_key`** — SiliconFlow API 密钥。默认为空
- **`api_base`** — SiliconFlow API 地址。默认 "https://api.siliconflow.cn/v1"
- **`model`** — STT 模型标识。默认 "FunAudioLLM/SenseVoiceSmall"

### `[aliyun_stt]` — 阿里云语音识别

当 `voice.stt_provider` 设为 `aliyun` 时生效。

- **`access_key_id`** — 阿里云 AccessKey ID。默认为空
- **`access_key_secret`** — 阿里云 AccessKey Secret。默认为空
- **`app_key`** — 智能语音交互项目 App Key。默认为空
- **`region`** — 服务区域。默认 "cn-shanghai"

### `[tencent_stt]` — 腾讯云语音识别

当 `voice.stt_provider` 设为 `tencent` 时生效。

- **`secret_id`** — 腾讯云 SecretId。默认为空
- **`secret_key`** — 腾讯云 SecretKey。默认为空
- **`engine`** — 识别引擎类型。默认 "16k_zh"
- **`region`** — 服务区域。默认 "ap-shanghai"

## 当前能力

### 入站消息（Discord -> MaiBot）

- Guild 频道消息
- DM 私聊消息
- Thread 子区消息
- 提及、引用回复、图片、贴纸
- Reaction 添加/移除事件
- 可选语音转文本（STT）

### 出站消息（MaiBot -> Discord）

- 普通文本
- 引用回复
- 用户/角色提及
- 图片与部分附件
- Reaction 添加/移除
- DM / Guild / Thread 路由
- 可选文本转语音（TTS）

### 运行时能力

- WebUI / `config.toml` 配置映射
- 连接状态上报
- 断线重连与健康检查
- 子区上下文路由
- Discord 平台消息 ID 回执回写
- 输入状态提示（Typing Indicator）
- 超长消息自动拆分

## 验证连接

启动 MaiBot 后，检查以下内容确认适配器工作正常：

1. **MaiBot 日志**：看到 `Discord 适配器启动任务已创建`，说明 Bot 已开始连接
2. **MaiBot 日志**：无 `connection.token 为空` 或 `Discord 客户端未就绪` 等错误
3. **发消息测试**：在 Discord 中向 Bot 发送私聊消息或在频道中 @Bot，看是否有回复

### 常见问题

**Bot 启动后没有连接 Discord**

- 检查 `plugin.enabled` 是否设为 `true`
- 检查 `connection.token` 是否填写正确
- 查看日志中是否有 Token 相关的错误

**频道中收不到消息**

- 确认已在 Developer Portal 中启用 **Message Content Intent**
- 检查 `connection.intent_message_content` 是否为 `true`
- 检查 `chat.guild_list` 和 `chat.channel_list` 的白名单配置
- 检查 `filters.ignore_bot_message` 是否意外屏蔽了目标用户

**无法连接 Discord 平台**

- Discord 服务在中国大陆无法直接访问，需要配置网络代理
- 推荐使用 TUN 模式代理，代理内核推荐使用 sing-box
- 检查代理是否正常工作

**语音功能不工作**

- 确认 `voice.enabled` 和 `connection.intent_voice_states` 均已设为 `true`
- 确认 Bot 拥有语音频道的 `View Channel`、`Connect`、`Speak` 权限
- 检查 TTS/STT 提供商的 API Key 是否有效
- 查看日志中是否有语音相关的错误信息

**子区（Thread）消息不响应**

- 检查 `chat.allow_thread_interaction` 是否为 `true`
- 检查 `chat.inherit_channel_permissions` 配置：如果父频道不在白名单中，继承开启时子区也会被过滤