---
title: 接入 QQ（NapCat）
description: 配置 NapCat WebSocket、机器人账号和入站出站白名单。
---

# 接入 QQ（NapCat）

先确认 [Web 私聊](./index)可以回复，再连接 QQ。需要另外准备已登录机器人 QQ 账号的 NapCat，并启用它的 **OneBot 正向 WebSocket 服务**。Kaguya 主动连接该地址。

## 填写连接信息

在 Web UI 的“概览”中打开 NapCat 设置；同一位置有独立开关。NapCat 是工作区级适配器，不随 Profile 切换。

**NapCat 开关** — 是否连接 NapCat，默认关闭。普通断线会显示“已开启、重连中”。

**WebSocket URL `wsUrl`** — NapCat 的正向 WebSocket 地址，以 `ws://` 或 `wss://` 开头。必须使用从 Kaguya 所在机器能够访问的地址；不要填 NapCat 管理网页地址。

**Access Token `accessToken`** — NapCat 为 WebSocket 设置的访问凭据。两端必须一致；NapCat 未设置认证时才留空。

**Self ID `selfId`** — 可选，机器人自己的 QQ 号，用于校验接收消息所属账号。填写时不要填群号或管理员 QQ 号。

**重连间隔 `reconnectMs`** — 连接断开后再次尝试的间隔，默认 `3000` 毫秒，范围 `100–3600000`。它不控制回复速度。

NapCat 设置保存后重启生效。白名单属于 Profile，保存后仍须到“配置生效管理”点击“应用当前配置”。

## 图片与其他媒体的当前边界

截至 2026-10-29，Kaguya 主线 `7edca245` 尚未接通通用识图。普通图片进入模型上下文时只剩 `[image]`。部分 QQ 表情保留平台资源字段，但图片字节没有进入主回复请求。更换多模态模型或开启 NapCat 文件选项，不能单独补齐这条链路。

语音、视频、文件和合并转发目前主要保留类型占位。引用回复保留原消息 ID，不主动从 NapCat 拉取原消息。独立采集字段 `captureEnabled`、`captureGroups` 和 `captureQueueLimit` 控制采集，不提供识图能力。

**消息上报格式** — 建议在 NapCat 的正向 WebSocket 设置中选择 `messagePostFormat: "array"`，保留结构化消息段。Kaguya 也能解析 CQ 字符串。[NapCat 基础配置](https://napneko.github.io/config/basic)

**`enableLocalFile2Url`** — 不是识图开关，不要求为当前 Kaguya 接入开启。所核对版本中，开启后 `get_file` 可以额外返回 base64。返回的本地路径属于 NapCat 所在机器，不能假定 Kaguya 能读取。[固定版本实现](https://github.com/NapNeko/NapCatQQ/blob/3420f0b76d7dc0ac92cde1663f21ea27f61e13bb/packages/napcat-onebot/action/file/GetFile.ts#L59)

**`parseMultMsg`** — 控制合并转发内容展开。当前 Kaguya 不消费展开内容，单独开启不会获得识图能力。

**图片链接有效期** — NapCat 官方文档说明，图片 URL 约两小时过期，并提供刷新方式。当前 Kaguya 尚未接通通用媒体刷新与识图流程。[文件处理说明](https://napneko.github.io/develop/file)

可切换识图及纯表情、图文混排仍处于规划阶段。设计依据、商城表情格式差异和验收要求见[通用媒体与可切换识图](../developers/media-understanding)，跟踪入口为 [Issue #272](https://github.com/posanbu/Kaguya/issues/272)。其中的拟新增配置尚不可用。

## 允许哪些群和私聊

配置页分别提供“入站白名单”和“出站白名单”，每行填写一条规则。

**入站** — 哪些群或用户的消息可以交给机器人处理。

**出站** — 机器人可以向哪些群或用户发送消息。

要在某个群正常聊天，需要两个方向都允许该群。例如，把下面内容分别填入两侧，将数字替换为真实群号和用户 QQ 号：

::: code-group

```text [指定群与私聊 ~vscode-icons:file-type-text~]
qq:group:123456789
qq:private:987654321
```

:::

**`qq:group:123456789`** — 允许这个群，范围包含群内成员的消息。

**`qq:private:987654321`** — 允许与这个 QQ 用户私聊。

**`qq:group:*` / `qq:private:*`** — 分别允许所有 QQ 群或所有 QQ 私聊。初次接入建议先填写具体目标，便于确认行为。

每侧多条规则满足任意一条即可。空列表拒绝该方向全部非 Web 消息；Web 私聊不受这些规则限制。格式错误的规则会被忽略，不会授予权限。

## 验证接入

1. 保存 NapCat 设置，开启 NapCat，再保存白名单并应用当前 Profile。
2. 在“Gateway / Adapter”确认 NapCat 已连接，Runtime 可用。
3. 在允许的群里 @ 机器人发送一句话，或从允许的 QQ 号私聊。

连接成功但不回复时，检查两个方向的白名单、模型配置和[发言设置](./reply-settings)。@ 会在默认设置下触发关注，但最终仍可能选择静默。

## 向其他会话发消息

在群聊中可以提出“私聊我：……”或“告诉小红：……”等请求。目标必须可识别、可达且在出站白名单中；陌生人不一定能私聊。操作方式和失败处理见[跨会话消息](./message-targets)。
