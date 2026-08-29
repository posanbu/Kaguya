---
title: Discord Adapter
---

# Discord Adapter

MaiBot's Discord platform adapter plugin, seamlessly bridging a Discord Bot with MaiBot through the Discord Gateway WebSocket. Supports Guild channels, DM chats, Threads, Reactions, and voice features.

## Adapter Repository

Discord adapter source code: [litroenade/MaiBot-Discord-Adapter](https://github.com/litroenade/MaiBot-Discord-Adapter)

## Create a Discord Bot

Before using the adapter, you need to create a Bot on Discord and obtain a Token.

### Step 1: Create an Application and Bot

1. Visit [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** in the top right corner, enter an application name, and create it
3. Click **Bot** in the left navigation bar
4. Click **Reset Token** (or **Add Bot**), copy the Bot Token and save it securely

### Step 2: Enable Privileged Gateway Intents

On the Bot page, scroll down to the **Privileged Gateway Intents** section and enable the following intents:

- **Message Content Intent** (required) — without this, the Bot cannot read message content
- **Presence Intent** (optional) — enable if you need to listen to user online status
- **Server Members Intent** (optional) — enable if you need to retrieve the full member list

::: warning Note
If **Message Content Intent** is not enabled, the Bot will not be able to read message text content, and `connection.intent_message_content` will not take effect even if set to `true`.
:::

### Step 3: Invite the Bot to a Server

1. Click **OAuth2** in the left navigation bar
2. In the **OAuth2 URL Generator**, select:
   - **Scopes**: check `bot`
   - **Bot Permissions**: check as needed:
     - Send Messages — send messages
     - Read Message History — read message history (required for reply quoting)
     - View Channels — view channels
     - Add Reactions — add emoji reactions
     - Connect — connect to voice channels (required for voice features)
     - Speak — speak in voice channels (required for voice features)
     - Attach Files — send attachments/images
3. Copy the generated invitation link, open it in a browser, and select your server to complete the invitation

::: tip Permission Suggestions
If you need voice features, the Bot must also have `View Channel`, `Connect`, and `Speak` permissions for the target voice channel, otherwise it cannot join and play audio.
:::

### Step 4: Get Server/Channel IDs

Server ID and channel ID are needed for chat filtering configuration. Enable Developer Mode in Discord:

1. Open Discord settings -> Advanced -> enable **Developer Mode**
2. Right-click the server icon -> Copy Server ID
3. Right-click the channel name -> Copy Channel ID

## Installation

Clone the adapter repository into MaiBot's `plugins/` directory:

::: code-group

```bash [Bash ~vscode-icons:file-type-shell~]
cd /path/to/MaiBot/plugins
git clone https://github.com/litroenade/MaiBot-Discord-Adapter.git
```

:::

You can also install the plugin through MaiBot's WebUI.

### Dependencies

- `maibot_sdk` >= 2.0.0 (provided by MaiBot)
- `discord.py` >= 2.3.0
- `discord-ext-voice-recv` >= 0.4.1a139 (required for voice features)
- `PyNaCl` >= 1.5.0 (required for voice features)

Voice-related dependencies are installed automatically when voice features are enabled. If you only need text messaging, no additional installation is required.

## Configuration

### Enable the Adapter

The adapter is **disabled by default** after installation and needs to be manually enabled.

#### Method 1: Edit Configuration File

Edit `plugins/MaiBot-Discord-Adapter/config.toml`, set `enabled` to `true` and fill in the Bot Token:

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[plugin]
enabled = true                # Enable the adapter
config_version = "1.0.0"

[connection]
token = "Your Discord Bot Token"  # Required
```

:::

Then restart MaiBot.

#### Method 2: Enable via WebUI

1. Open MaiBot WebUI in a browser and log in with an Access Token
2. Click **"Plugin Management"** in the left menu
3. Find **"Discord Adapter"** and toggle the enable switch
4. Fill in `connection.token` in the configuration
5. Save the configuration and restart MaiBot (or wait for plugin hot reload)

::: tip Tip
Configuration can also be hot-reloaded via the WebUI plugin configuration page without restarting MaiBot.
:::

### Chat Filtering

The adapter enables chat list filtering by default, with the list mode set to **blacklist** (i.e., allows all sources by default). If you need to restrict the Bot to only respond to specific servers or channels, change the mode to whitelist and fill in the corresponding IDs:

::: code-group

```toml [TOML ~vscode-icons:file-type-toml~]
[chat]
guild_list_type = "whitelist"
guild_list = ["Your Server ID"]
channel_list_type = "whitelist"
channel_list = ["Your Channel ID"]
```

:::

If the Bot is connected but not responding to messages, check the chat filtering configuration first.

## Configuration Reference

### `[plugin]` — Plugin Settings

- **`enabled`** — Whether to enable the Discord adapter. When disabled, the plugin remains idle and does not establish a Discord connection. Default: false
- **`config_version`** — Current configuration structure version (auto-maintained, no manual modification needed). Default: "1.0.0"

### `[connection]` — Discord Connection

- **`token`** — Discord Bot Token, copied from the Bot page in Developer Portal. Required when enabling the adapter. Default: empty
- **`intent_messages`** — Server message permission (Guild Messages), controls server channel/thread messages. Default: true
- **`intent_guilds`** — Server permission (retrieve server information). Default: true
- **`intent_dm_messages`** — Direct message permission (Direct Messages), controls DM messages. Default: true
- **`intent_message_content`** — Message content permission, must be enabled or message content cannot be read. Default: true
- **`intent_voice_states`** — Voice state permission, required for voice features; can be disabled for text-only usage. Default: false
- **`retry_delay`** — Reconnection retry interval (seconds). Default: 5
- **`connection_check_interval`** — Connection status check interval (seconds, recommended 30 seconds or more). Default: 30

### `[chat]` — Chat Filtering

- **`guild_list_type`** — Server list mode, options: `whitelist` or `blacklist`. Default: "blacklist"
- **`guild_list`** — Server ID list. Default: empty
- **`channel_list_type`** — Channel list mode. Default: "blacklist"
- **`channel_list`** — Channel ID list. Default: empty
- **`thread_list_type`** — Thread list mode (ignored when inheriting channel permissions). Default: "blacklist"
- **`thread_list`** — Thread ID list. Default: empty
- **`user_list_type`** — User list mode. Default: "blacklist"
- **`user_list`** — User ID list. Default: empty
- **`allow_thread_interaction`** — Whether to allow interaction in Threads. Default: true
- **`inherit_channel_permissions`** — Whether threads inherit parent channel permissions. When enabled, if the parent channel is allowed, the thread is also allowed, and the thread list is ignored. Default: true
- **`inherit_channel_memory`** — Whether threads inherit parent channel memory. When enabled, threads share context memory with the parent channel; when disabled, they are independent. Default: true
- **`show_typing_indicator`** — Whether to show Discord's "typing" indicator after receiving a processable message. Default: true
- **`typing_indicator_delay_ms`** — Delay before showing the typing indicator (milliseconds), to avoid flashing on very fast replies. Default: 0
- **`typing_indicator_timeout_sec`** — Maximum duration to show the typing indicator (seconds). Set to 0 to never time out until a reply is sent. Default: 0

::: tip Chat Filtering Explanation
- **Whitelist mode**: only processes messages from servers/channels/users in the list; others are discarded
- **Blacklist mode**: processes all messages except those from servers/channels/users in the list
- All list modes default to blacklist (allow all). If the Bot is connected but not responding, check the list configuration first
:::

### `[platform]` — Platform Settings

- **`platform_name`** — Platform identifier, used to distinguish different Discord instances in MaiBot. Must be unique when running multiple instances. Default: "discord"

### `[filters]` — Message Filtering

- **`ignore_self_message`** — Whether to ignore messages sent by the bot itself. Recommended to keep enabled to prevent the bot from processing its own messages. Default: true
- **`ignore_bot_message`** — Whether to ignore messages sent by other bots. Default: true

### `[voice]` — Voice Features

- **`enabled`** — Whether to enable voice features. When disabled, no voice manager is created and no voice channels are joined. Default: false
- **`voice_mode`** — Voice channel mode: `fixed` stays in a specified channel; `auto` joins when someone enters and leaves when empty. Default: "auto"
- **`fixed_channel_id`** — Voice channel ID for fixed mode (use the voice channel ID, not the category ID). Default: empty
- **`auto_channel_list`** — Candidate voice channel ID list for auto mode; only listed voice channels will be joined/left automatically. Default: empty
- **`idle_timeout_sec`** — Seconds to wait before leaving when empty in auto mode. Default: 300
- **`tts_provider`** — TTS voice synthesis provider, options: `siliconflow` / `gptsovits` / `minimax`. Default: "siliconflow"
- **`stt_provider`** — STT voice recognition provider, options: `siliconflow_sensevoice` / `aliyun` / `tencent`. Default: "siliconflow_sensevoice"
- **`enable_vad`** — Whether to enable volume-based Voice Activity Detection (VAD). Default: true
- **`vad_threshold_db`** — VAD volume threshold (dB). Values above this are considered as speaking. Range: approximately -60 (sensitive) to -30 (strict). Default: -50.0
- **`vad_deactivation_delay_ms`** — VAD deactivation delay (milliseconds), waits this long after the threshold is crossed to determine speech has stopped, to avoid splitting sentences. Default: 500
- **`send_text_in_voice`** — Whether to also send text to the voice channel text area when using TTS (for debugging). Default: false

::: warning Voice Prerequisites
Enabling voice features requires all of the following conditions:

- `voice.enabled = true`
- `connection.intent_voice_states = true`
- Bot has `View Channel`, `Connect`, and `Speak` permissions for the target voice channel
:::

### `[siliconflow_tts]` — SiliconFlow TTS

Takes effect when `voice.tts_provider` is set to `siliconflow`.

- **`api_key`** — SiliconFlow API key. Default: empty
- **`api_base`** — SiliconFlow API address. Default: "https://api.siliconflow.cn/v1"
- **`model`** — TTS model identifier. Default: "fnlp/MOSS-TTSD-v0.5"
- **`voice`** — TTS voice identifier. Default: "fnlp/MOSS-TTSD-v0.5:alex"
- **`sample_rate`** — Audio sample rate. opus only supports 48000; wav/pcm supports 8000/16000/24000/32000/44100; mp3 supports 32000/44100. Default: 32000
- **`speed`** — Speech speed (0.1 ~ 2.0). Default: 1.0
- **`response_format`** — Audio return format (mp3/opus/wav/pcm), wav recommended. Default: "wav"

### `[gptsovits_tts]` — GPT-SoVITS TTS

Takes effect when `voice.tts_provider` is set to `gptsovits`.

- **`api_base`** — GPT-SoVITS API address. Default: "http://127.0.0.1:8000"
- **`version`** — GPT-SoVITS service version. Default: "v4"
- **`model`** — Template model name, used for the infer_single template model interface. The config page will preferentially fetch template models from the local GSV server for selection. Default: empty
- **`voice`** — Template emotion/voice (optional), leave empty for automatic selection. Default: empty
- **`text_lang`** — Synthesis language code. Default: "zh"
- **`response_format`** — Expected audio format, wav recommended. Default: "wav"
- **`speed_factor`** — Speech speed factor. Default: 1.0

::: tip About Template Models
The config page will preferentially fetch the template model list from the local GPT-SoVITS service's `/models/{version}` endpoint for selection. If fetching fails, you can also fill it in manually. Do not fill in OpenAI-compatible model IDs like `GSVI-v4`.
:::

### `[minimax_tts]` — MiniMax TTS

Takes effect when `voice.tts_provider` is set to `minimax`.

- **`api_key`** — MiniMax API key. Default: empty
- **`api_base`** — MiniMax API address. Default: "https://api.minimax.io"
- **`model`** — TTS model. Default: "speech-2.8-hd"
- **`voice_id`** — Voice ID. Default: "male-qn-qingse"
- **`speed`** — Speech speed (0.5 ~ 2.0). Default: 1.0
- **`vol`** — Volume (0.1 ~ 2.0). Default: 1.0
- **`pitch`** — Pitch offset (-12 ~ 12). Default: 0.0
- **`audio_sample_rate`** — Output sample rate, options: 8000/16000/22050/24000/32000/44100. Default: 32000
- **`output_format`** — Audio encoding format (pcm/mp3/flac/wav). Default: "mp3"

### `[siliconflow_stt]` — SiliconFlow STT

Takes effect when `voice.stt_provider` is set to `siliconflow_sensevoice`.

- **`api_key`** — SiliconFlow API key. Default: empty
- **`api_base`** — SiliconFlow API address. Default: "https://api.siliconflow.cn/v1"
- **`model`** — STT model identifier. Default: "FunAudioLLM/SenseVoiceSmall"

### `[aliyun_stt]` — Alibaba Cloud Speech Recognition

Takes effect when `voice.stt_provider` is set to `aliyun`.

- **`access_key_id`** — Alibaba Cloud AccessKey ID. Default: empty
- **`access_key_secret`** — Alibaba Cloud AccessKey Secret. Default: empty
- **`app_key`** — Intelligent Speech Interaction project App Key. Default: empty
- **`region`** — Service region. Default: "cn-shanghai"

### `[tencent_stt]` — Tencent Cloud Speech Recognition

Takes effect when `voice.stt_provider` is set to `tencent`.

- **`secret_id`** — Tencent Cloud SecretId. Default: empty
- **`secret_key`** — Tencent Cloud SecretKey. Default: empty
- **`engine`** — Recognition engine type. Default: "16k_zh"
- **`region`** — Service region. Default: "ap-shanghai"

## Current Capabilities

### Inbound Messages (Discord -> MaiBot)

- Guild channel messages
- DM private messages
- Thread messages
- Mentions, reply quoting, images, stickers
- Reaction add/remove events
- Optional speech-to-text (STT)

### Outbound Messages (MaiBot -> Discord)

- Plain text
- Reply quoting
- User/role mentions
- Images and some attachments
- Reaction add/remove
- DM / Guild / Thread routing
- Optional text-to-speech (TTS)

### Runtime Capabilities

- WebUI / `config.toml` configuration mapping
- Connection status reporting
- Automatic reconnection and health check
- Thread context routing
- Discord platform message ID receipt writing
- Typing indicator
- Automatic splitting of long messages

## Verify Connection

After starting MaiBot, check the following to confirm the adapter is working:

1. **MaiBot logs**: seeing `Discord adapter startup task created` means the Bot has started connecting
2. **MaiBot logs**: no errors like `connection.token is empty` or `Discord client not ready`
3. **Message test**: send a DM to the Bot in Discord or @mention the Bot in a channel and see if it replies

### Common Issues

**Bot does not connect to Discord after startup**

- Check if `plugin.enabled` is set to `true`
- Check if `connection.token` is filled in correctly
- Look for Token-related errors in the logs

**Cannot receive messages in channels**

- Confirm that **Message Content Intent** is enabled in Developer Portal
- Check if `connection.intent_message_content` is `true`
- Check the whitelist configuration in `chat.guild_list` and `chat.channel_list`
- Check if `filters.ignore_bot_message` is unintentionally blocking the target user

**Cannot connect to Discord platform**

- Discord services are not directly accessible from mainland China; a network proxy is required
- TUN mode proxy is recommended, with sing-box as the recommended proxy core
- Check if the proxy is working properly

**Voice features not working**

- Confirm that both `voice.enabled` and `connection.intent_voice_states` are set to `true`
- Confirm that the Bot has `View Channel`, `Connect`, and `Speak` permissions for the voice channel
- Check if the TTS/STT provider's API key is valid
- Look for voice-related error messages in the logs

**Thread messages not responding**

- Check if `chat.allow_thread_interaction` is `true`
- Check the `chat.inherit_channel_permissions` configuration: if the parent channel is not in the whitelist and inheritance is enabled, the thread will also be filtered
