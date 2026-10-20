---
title: QQ 语音回复
description: 配置 Qwen-TTS、初始化音色、试听并验证 QQ 投递。
---

# QQ 语音回复

TTS 默认关闭。开启后，仅为明确列出的 QQ 群或私聊生成语音；不适合朗读的正文仍发送文字。
语音合成失败时只回退一次原文。Web、跨会话发送和需要正文确认的发送继续使用文字。

## 配置位置与生效方式

无需使用 Web 控制台。停止服务，打开配置根下 `index.json`，找到 `selectedProfileId`，
编辑 `profiles/profile_<id>.json` 中一个 provider 的 `settings.tts`，然后重新启动。
默认配置根是仓库 `.data/kaguya-config`，也可以由 `KAGUYA_CONFIG_ROOT` 指定。
通过现有 Profile API 保存时，使用配置应用操作可以热重载。

API Key 仍放在该 provider 原有 `apiKey` 字段，**不要放入 settings、音色名称、Prompt 或日志**。
允许复用已有的同区域百炼 provider，也可以新增专用 provider，保留现有 Light/Heavy 档位配置。
专用 provider 的 `enabled` 需为 true，`models` 至少填写合成模型名称，但不要将它选为聊天档位。
同一 Profile 最多启用一个 TTS provider。

将以下对象放入 provider 的 `settings.tts`。先保持 `enabled: false` 完成音色与试听准备，
最后再启用；示例中的账号标识、音色、下载域名和群号必须替换为实际值。

::: code-group

```json [settings.tts ~vscode-icons:file-type-json~]
{
  "enabled": false,
  "region": "beijing",
  "accountScope": "my-beijing-account",
  "model": "qwen3-tts-vc-2026-01-22",
  "voice": "YOUR_VOICE_ID",
  "language": "Chinese",
  "audioHosts": ["YOUR_BUCKET.oss-cn-beijing.aliyuncs.com"],
  "conversations": ["qq:group:123456"],
  "maxCharacters": 300,
  "timeoutMs": 30000,
  "requestTtlMs": 120000
}
```

:::

**region** — `beijing` 或 `singapore`。创建音色与合成必须使用同一账号、区域和目标模型。

**accountScope** — 非秘密的账号标识，用于区分持久化任务。更换实际账号时也更换此值，避免复用旧账号的任务。

**audioHosts** — 实际合成响应的 OSS 下载主机名，小写、精确匹配。不能填写任意 URL、IP 或通配符。
根据该区域的服务响应核实主机名；不要直接复制签名 URL。主机不匹配会安全回退，不会向任意地址下载。

**conversations** — `qq:group:群号` 或 `qq:private:用户号`，不接受通配符。
它不替代既有出站白名单；两处必须同时允许，NapCat 也必须启用。

**maxCharacters** — 默认 300，最多 600 个 Unicode 字符。空白、超长、代码块、表格、URL 保持文字；不会偷偷改写批准正文。

**timeoutMs / requestTtlMs** — 默认合成总超时 30 秒、整个请求有效期 120 秒。超过有效期或回合已结束不再发送迟到语音。

## 创建或查询音色

客户端针对 Issue #214 的 **Qwen3-TTS 非实时协议**，不是 Qwen-Audio、Omni 或 WebSocket 实时协议。
阿里云文档中的新模型及音色 API 可能使用不同协议；不要只替换模型名混用。
已有音色 ID 可以直接配置，但必须属于自己的部署账号并与目标模型匹配。

仓库没有附带八千代参考录音，也没有验证第三方示例音色在你的账号下可用。
准备可用于该用途的清晰 WAV 参考音频，管理命令限制 10 MiB；时长和采样要求以该模型服务端校验为准。
以下命令读取选中 Profile 的 `qwen-tts` provider，替换为你的 provider ID。创建和试听都是显式云端调用，可能产生费用；机器人正常回复不会创建音色。

::: code-group

```powershell [PowerShell ~vscode-icons:file-type-powershell~]
corepack pnpm exec tsc -b

# 分页查询账号下的音色；返回 voice 和 targetModel
node apps/server/dist/tts-cli.js list qwen-tts 0

# 使用本地参考 WAV 创建一次音色，不自动修改配置
node apps/server/dist/tts-cli.js create qwen-tts yachiyo "D:\audio\reference.wav"

# 把返回的 voice 填入 settings.tts.voice，再生成本地试听文件
node apps/server/dist/tts-cli.js sample qwen-tts "晚上好，今天过得怎么样？" "D:\audio\sample.wav"
```

:::

输出文件必须尚不存在。试听失败时可能留下空的目标文件，检查后删除或换文件名再试。
命令不会自动重试、修改配置或发送 QQ 消息。参考音频仅上传至所选区域的音色管理接口，不进入账本。
音色查询支持分页；一次查询不表示已经检索账号全部音色。

协议资料：[Qwen-TTS API](https://www.alibabacloud.com/help/zh/model-studio/qwen-tts-api)、
[音色复刻文档](https://www.alibabacloud.com/help/zh/model-studio/voice-cloning-user-guide)。
服务接口和模型可用性会变化，实际账号兼容性需要通过查询和试听验证。

## QQ 验证

先完成 [NapCat 接入](./napcat)，再把 `enabled` 改为 true，并只允许一个测试会话。
发送一条能触发短回复的消息，检查收到一条语音、没有重复文字；再测试超长文字仍走文字。
合成失败会回退原文；若平台发送已发生但回执不确定，不盲目补发第二条文字。

Kaguya 将已校验的 WAV 通过 OneBot `record` 的 base64 文件参数交给 NapCat。
不要求两端共享磁盘目录。该参数只存在于发送过程，不写入事件账本。
不同 NapCat 部署的 WAV 支持仍须实际验证；平台成功回执不代表用户已播放。

## 存储、恢复与排查

音频放在配置根的 `tts-audio`。WAV 按 SHA-256 命名，另有任务索引；读取时检查大小与摘要。
POSIX 文件权限为 0600、目录 0700，Windows 请将 NTFS ACL 限制为服务账号。
此目录只供一个服务进程使用，不能让多个进程同时管理同一缓存。

默认上限为 512 MiB、10,000 个文件。产物及索引最近访问后保留 24 小时，
在存储打开、语音规划及保存时清理过期文件；闲置期间没有后台清理定时器。
配额满时拒绝新产物并回退文字，不驱逐仍有效的文件。
请求最多有效 5 分钟，保留窗口覆盖正常发送与重试；历史音频过期不改变已记录的正文及投递事实。
本版没有 Web 音频播放器，历史中保留语音标记和正文。

模块检查页的“语音任务”按事件展示等待、执行、结果和取消；沿引用查看平台回执。
结果记录处理耗时和输入字符数，输入字符数**不是账单用量**。供应商返回有效字符用量时单独记录；
未返回或只恢复到已有产物时显示未知，不当作零用量。
`ttsFallbackReason` 表示文字回退原因：合成失败、存储失败、产物缺失或执行结果未知。
供应商已成功但本地未保存即崩溃时，下次恢复保守回退文字，不再次合成；不能保证远端计费恰好一次。

若没有语音任务，先查开关、会话列表、出站白名单、NapCat 状态、文本策略与跨会话限制。
若有任务但失败，检查 Key/区域/音色/模型一致性、OSS 主机、网络和存储配额。
不要把密钥、原始供应商错误或签名下载地址粘贴进公共日志。

离线测试覆盖事件链、恢复、取消、完整性与消息转换；真实 Qwen 合成、八千代音色试听、QQ 接收仍需部署账号验收。
