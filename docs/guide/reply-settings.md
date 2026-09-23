---
title: 发言、休眠与等待
description: 调整唤醒状态、休眠策略、关注租约和 Planner 等待。
---

# 发言、休眠与等待

在“检查 → 模块”打开对应模块，修改参数并保存，再到“配置生效管理”应用。时间字段以 `Ms` 结尾时，单位是毫秒，`1000` 毫秒等于 `1` 秒。

Kaguya 默认处于 `awake`。入站通知按会话 scope 积攒；没有开放观察时立即产生观察机会，Arousal 在 awake 状态默认 `observe`，然后 Heartflow 才读取该 scope 的全部未读并交给 Planner。是否发言仍由 Planner 的 `message | wait | silent` 决定，不存在关键词评分、频率抽样、固定 tick 或普通消息防抖。

## 唤醒与休眠：Attention Arousal

模块实例为 `attention-arousal.default`。

**`idleSleepEnabled`** — 是否启用全局无消息休眠，默认关闭。

**`idleSleepAfterMs`** — 启用后，连续多久没有全局消息进入休眠，默认 `120000`（2 分钟）。

**`nightSleepEnabled`** — 是否启用夜间休眠，默认关闭。

**`nightSleepStart` / `nightSleepEnd`** — 本地时间的夜间窗口，格式 `HH:mm`，默认 `23:00–07:00`，支持跨午夜。

**`periodicWakeEnabled`** — 是否让休眠状态周期唤醒，默认开启。只有进入休眠后才生效。

**`periodicWakeEveryMs`** — 休眠后多久复查一次积压，默认 `300000`（5 分钟）。

私聊、Web、@机器人、@全体、回复机器人、有效 Focus 和周期复查会唤醒并观察。普通群聊在 asleep 时延后，不推进未读水位；消息会继续按 scope 积攒。

## 观察后的行为：Heartflow

模块实例为 `heartflow.default`。

**`muted`** — 静默模式，默认 `false`。它在 observe 后抑制主动回复，不改变 Arousal 的唤醒状态。

**`focusIdleMs`** — 群聊直接通知观察后开启、成功投递后续租的 Focus 租约时长，默认 `120000`（2 分钟），范围 `1000–3600000`。`wait` 保持租约自然到期，`silent` 或失败会关闭它。

**`staleAfterMs`** — 最近输入多久以前算积压，默认 `120000`。它只供 Planner 判断，不会删除消息或改变是否观察。

**`plannerInterruptMaxConsecutiveCount`** — 新消息到来时，同一轮最多重新规划几次，默认 `2`，范围 `0–20`；设为 `0` 关闭规划打断。

## Planner 等待：Heartbeat

模块实例为 `heartbeat.default`。Heartbeat 不为普通入站设置防抖 timer；以下设置只约束 Planner wait、规划打断和静默后的退避恢复。

**`plannerInterruptQuietMs`** — 规划被新消息打断后，等待安静多久再继续，默认 `1000`，范围 `0–60000`。

**`maxReplacementAttempts`** — 当前轮次最多替换候选的次数，默认 `3`，范围 `1–20`。

**`totalWaitBudget`** — Planner 连续选择 `wait` 的次数上限，默认 `3`，范围 `0–20`。

**`noActionBackoffStartCount`** — 连续多少次 `silent` 后开始延长再次规划的间隔，默认 `2`。

**`noActionBackoffBaseMs` / `noActionBackoffCapMs`** — 首次退避和最长退避，默认分别为 `15000` 与 `300000`。

**`noActionBackoffBypassPendingCount`** — scope 积攒至少多少条新消息时跳过退避，默认 `6`；`0` 表示不按数量跳过。

旧版评分、阈值、叫名强制、动态频率和消息防抖设置已删除。该协议是破坏式更新，旧数据库与旧模块配置需要重置。
