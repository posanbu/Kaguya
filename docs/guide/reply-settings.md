---
title: 发言、休眠与等待
description: 调整唤醒状态、休眠策略、关注租约和 Light 等待。
---

# 发言、休眠与等待

在“检查 → 模块”打开对应模块，修改参数并保存，再到“配置生效管理”应用。时间字段以 `Ms` 结尾时，单位是毫秒，`1000` 毫秒等于 `1` 秒。

Lifecycle 的公开实例为 `lifecycle.default`。配置分为 `pulse`、`activity`、`sleep` 和 `observation`。Router 和 Light 判断是否参与，Heavy 生成表达。清醒时每 5 秒推进活动，但不因节拍直接请求模型。

## 时间节拍与当前活动

**`pulse.intervalMs`** — 清醒节拍间隔，默认 `5000`（5 秒）。入睡后停止，唤醒后恢复。重启不逐跳补跑。

**`activity.scopeIdleMs`** — 本会话最后一次实际活动后的退出期限，默认 `120000`（2 分钟）。退出后转为发呆。关注期限共用这一时长和实际活动时间。

情境页独立显示当前活动及最近十分钟的合并时间线。相同活动和目标合并为一个时间段。过渡句只供内部情境和控制台使用。

## 睡眠与唤醒

以下字段位于 `sleep` 对象。

**`idleSleepEnabled`** — 是否启用全局空闲入睡，默认开启。

**`idleSleepAfterMs`** — 全局最后一次实际活动后多久入睡，默认 `600000`（10 分钟）。正在执行的模型步骤阻止空闲入睡。节拍、状态文案和空复查不刷新空闲期限。

**`nightSleepEnabled`** — 是否启用夜间休眠，默认关闭。

**`nightSleepStart` / `nightSleepEnd`** — 本地时间的夜间窗口，格式 `HH:mm`，默认 `23:00–07:00`，支持跨午夜。

**`periodicWakeEnabled`** — 是否周期复查积压，默认开启。空复查继续睡，不请求模型。

**`periodicWakeEveryMs`** — 休眠后多久复查一次积压，默认 `300000`（5 分钟）。

私聊、Web、@机器人、@全体和回复机器人立即唤醒。普通群消息在睡眠期间积攒，不推迟既定复查时间。有积压的复查会进入观察流程。

## 观察后的行为：Router

模块实例为 `router.default`。

**`muted`** — 静默模式，默认 `false`。它在 observe 后抑制主动回复，不改变 Lifecycle 的睡眠状态。

**`focusIdleMs`** — 启用 Lifecycle 时由 `activity.scopeIdleMs` 统一提供。直接通知开启关注，实际活动续租。`wait` 保持租约自然到期，`silent` 或失败关闭它。

**`staleAfterMs`** — 最近输入多久以前算积压，默认 `120000`。它只供 Light 判断，不会删除消息或改变是否观察。

**`lightInterruptMaxConsecutiveCount`** — 新消息到来时，同一轮最多重新规划几次，默认 `2`，范围 `0–20`；设为 `0` 关闭规划打断。

## 观察调度

以下字段位于 Lifecycle 的 `observation` 对象，约束 Light 等待、规划打断和静默后的退避恢复。普通入站不设置防抖 timer。

**`interruptQuietMs`** — 规划被新消息打断后，等待安静多久再继续，默认 `1000`，范围 `0–60000`。

**`maxReplacementAttempts`** — 当前轮次最多替换候选的次数，默认 `3`，范围 `1–20`。

**`totalWaitBudget`** — Light 连续选择 `wait` 的次数上限，默认 `3`，范围 `0–20`。

**`noActionBackoffStartCount`** — 连续多少次 `silent` 后开始延长再次规划的间隔，默认 `2`。

**`noActionBackoffBaseMs` / `noActionBackoffCapMs`** — 首次退避和最长退避，默认分别为 `15000` 与 `300000`。

**`noActionBackoffBypassPendingCount`** — scope 积攒至少多少条新消息时跳过退避，默认 `6`；`0` 表示不按数量跳过。

启动时合并旧 Arousal 与 Heartbeat 配置，并在配置根的 `migrations/lifecycle-v1.json` 保存备份。迁移支持重复执行，保留旧订阅消费进度和存量调度，不需要重置数据库。
