# Heartbeat

## 目的与非目标

Heartbeat 可靠地按 scope 积攒入站注册水位并产生观察机会。它不判断正文含义、话题或回复动作，也不按固定 tick 轮询。

## 消费和产生

消费入站文本、Arousal 状态、`agent.wait.requested`、one-shot due 和观察/回合终态；产生全局活动、heartbeat 生命周期、开放观察 wake 与 `agent.turn.candidate`。

## 数据流与边界

每条入站先投影不含正文的活动事实，再直接为所属 scope 竞争唯一开放观察。Candidate 只记录排他下界、包含式上界、未读数量和 `private / web / mention-self / mention-all / reply-self / passive / recheck` 信号，不冻结正文。开放期间和 asleep defer 后的新消息继续留在未读水位中。

只有 `agent.turn.context.completed.observedThroughInformationId` 是成功观察水位。查询按注册位置而非消息时间戳推进，最多冻结 1000 条；上界之后的消息留给下一次观察。

## Settings

`plannerInterruptQuietMs` 控制规划打断后的安静窗口；`maxReplacementAttempts` 与 `totalWaitBudget` 限制替换和 Planner wait；`noActionBackoffStartCount`、`noActionBackoffBaseMs`、`noActionBackoffCapMs`、`noActionBackoffBypassPendingCount` 控制连续 silent 后的退避恢复。普通入站没有 `messageDebounceMs`。

## 可靠性、幂等和失败行为

同 scope 的 `openScope` 保持唯一开放 candidate；注册、替换和 terminal 使用稳定键。defer、重复 delivery、调度失败、进程重启和没有冻结 context 的终态都不推进水位。durable one-shot 只用于 Planner wait/interrupt、silent 后恢复以及 Arousal 自己的绝对休眠 deadline，不使用 cadence、tick 或计数器。

## 日志与可观测性

记录 candidate 的触发类型、未读数量和水位，以及 scheduled、fired、superseded、failed 生命周期；不记录未观察正文。

## 典型场景

awake 收到普通通知时立即创建观察机会；开放期间的新通知按 scope 积攒。asleep 时普通机会 defer，直接通知或周期 wake 可重新观察全部积压。Planner wait 到期沿原水位恢复，不把通知逐条变成回复。
