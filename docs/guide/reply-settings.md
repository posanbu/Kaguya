---
title: 发言频率与等待
description: 调整群聊参与、叫名响应、连续消息等待和静默退避。
---

# 发言频率与等待

在“检查 → 模块”打开对应模块，修改参数并保存，再到“配置生效管理”应用。以下默认值指新安装的生产配置，已有实例保留自己的设置。时间字段以 `Ms` 结尾时，单位是毫秒，`1000` 毫秒等于 `1` 秒。

## 先按现象选择设置

**群聊太活跃** — 降低 Heartflow 的 `groupFrequency`，或用动态频率在指定时段降低参与。

**连续发几句时回复太早** — 增大 Heartbeat 的 `messageDebounceMs`，给连续输入留出时间。

**叫名字不容易响应** — 检查身份别名，按需要开启 Attention Arousal 的 `forceNameReply`。

**回复内容太长或不合口吻** — 修改[角色与回复风格](./persona)，频率设置主要控制何时参与。

**完全不回复** — 先检查连接、白名单、模型和静默模式，再调整频率，见[常见问题](./troubleshooting)。

## 群聊和私聊频率：Heartflow

模块实例为 `heartflow.default`。

**`groupFrequency` / `privateFrequency`** — 群聊与私聊的基础参与频率，范围 `0–1`，均默认 `1`。降低会减少参与机会；`1` 也不保证每条消息必回，后续判断仍可以等待或静默。

**`muted`** — 静默模式，默认 `false`。需要暂时抑制回复时开启。

**`focusFrequencyMultiplier`** — 已处于关注状态时的频率倍率，范围 `0–4`，默认 `1`，最终频率不超过 `1`。

**`focusIdleMs`** — 群聊直接唤醒或成功参与后，持续关注的空闲期限，默认 `120000`（2 分钟），范围 `1000–3600000`。关注不代表每句必回。

**`staleAfterMs`** — 最近输入多久以前算积压消息，默认 `120000`。积压交给 Planner 判断，不等于到期删除或自动回复。

**`plannerInterruptMaxConsecutiveCount`** — 新消息到来时，同一轮最多重新规划几次，默认 `2`，范围 `0–20`；设为 `0` 关闭此类打断。调大可能增加等待和模型调用。

**`botNames`** — 只读，来自工作区名称与别名。修改称呼请到身份编辑器。

### 按时段调整频率

**`dynamicFrequencyEnabled`** — 是否启用动态频率，默认关闭。

**`dynamicFrequencyRules`** — 规则列表。`platform` 为平台（如 `qq`），`itemId` 为会话目标 ID，`chatType` 为 `group` 或 `private`，`time` 为 `HH:mm-HH:mm`，`value` 为 `0–1` 的频率。空平台或目标表示不限定，空时间表示全天；支持跨午夜。

时间按运行 Kaguya 的服务器本地时区匹配；当前不会使用 Profile 的身份时区来转换这些规则。具体会话规则优先，没有命中时使用基础频率。初始群聊规则为 `00:00–08:59` 使用 `0.8`，`09:00–18:59` 使用 `1`，需要开启动态频率后才生效。

## @ 与叫名：Attention Arousal

模块实例为 `attention-arousal.default`。

**`forceDirectReply`** — 默认 `true`。被 @ 或收到对机器人消息的回复时，直接进入规划；名称含有 Reply，但仍不是强制发送回答。

**`forceNameReply`** — 默认 `false`。开启后，文字中叫到机器人名字也直接进入规划；关闭时只增加相关性评分。

**`threshold`** — 关注阈值，范围 `0–100`，默认 `80`。调低更容易进入后续处理。

**`focusRelevance`** — 已有群聊关注状态的相关性分数，范围 `0–100`，默认 **`40`**。它仍受门控约束，不是模型算出的语义相关度。

**`deferMs`** — 延后处理的等待时间，默认 `15000`（15 秒）。

**`policyDigest` / `settingsDigest`** — 记录策略与设置版本的标识，默认分别为 `attention-arousal:maibot-v1`、`attention-arousal:default-v1`。一般使用者无需修改。

## 连续消息与等待：Heartbeat

模块实例为 `heartbeat.default`。

**`messageDebounceMs`** — 收集同一会话连续消息的等待时间，默认 `1500`。调大可以等对方多说几句，代价是更晚开始处理。

**`plannerInterruptQuietMs`** — 规划被新消息打断后，等待安静多久再继续，默认 `1000`，范围 `0–60000`。

**`maxReplacementAttempts`** — 当前轮次最多替换候选的次数，默认 `3`，范围 `1–20`。

**`totalWaitBudget`** — 连续选择等待或延后关注的次数上限，默认 `3`，范围 `0–20`。

### 多次没有动作后的等待

这些设置用于尚未处于关注状态的群聊，减少连续静默时的反复判断。初次使用保留默认即可。

**`noActionBackoffStartCount`** — 连续静默多少次后开始延长等待，默认 `2`。

**`noActionBackoffBaseMs`** — 首次延长等待的基准时间，默认 `15000`。

**`noActionBackoffCapMs`** — 最长等待时间，默认 `300000`（5 分钟）。

**`noActionBackoffBypassPendingCount`** — 积累多少条新消息后可以跳过上述等待，默认 `6`；`0` 表示不按消息数量跳过。
