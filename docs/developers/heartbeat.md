# Scope 通知观察与等待恢复

Heartbeat 是一个显式激活的 Information Module。它不调用 LLM 或平台 transport，也不按固定 tick 轮询。入站注册后，它只为对应 scope 竞争一个不含正文的 `agent.turn.candidate`；正文仍留在 Information Ledger，直到 Arousal 决定 `observe` 后才由 Heartflow 按水位读取。

## 入站与水位

每条入站先写入不含正文的全局 `agent.attention.arousal.activity`，再检查该 scope 的开放观察：

- 没有开放观察时，立即登记 candidate，冻结最近一次成功观察后的排他下界、本次注册水位的包含式上界、未读数量和平台通知信号。
- 已有开放观察时，新通知继续积攒在同一 scope；直接通知可登记 wake 事实，但不会把正文复制到 candidate。
- `awake` 时 Arousal 默认 `observe`；`asleep` 且没有直接通知、有效 Focus 或周期复查时 `defer`。
- `defer`、重复投递、调度失败和进程重启都不推进已观察水位。只有 Heartflow 成功冻结 turn context 后，`observedThroughInformationId` 才成为下一次查询下界。

注册顺序而不是消息时间戳决定边界，因此晚到时间戳不能跨过已经冻结的水位。上界之后登记的消息留给下一次观察。

## One-shot 调度

普通入站不创建消息防抖 timer，也没有固定 cadence、全局 tick 或心跳计数。持久化 one-shot 用于：

- Planner 的 `wait` 与规划中断后的 quiet window；
- Arousal 的全局空闲休眠、夜间边界和休眠周期唤醒。

schedule 使用绝对 `dueAt` 和稳定 operation key。Runtime 关闭时不把开放 schedule 写成 cancelled；重启后从数据库恢复并处理 overdue schedule。`replace` 和 terminal 提交都保持幂等，旧代际到期不能产生第二个有效 candidate。

## 事实链

```text
inbound
  -> agent.attention.arousal.activity
  -> agent.turn.candidate
  -> agent.attention.arousal.completed: observe | defer
  -> observe: agent.turn.claimed -> agent.turn.context.completed
  -> Planner: message | wait | silent
  -> agent.turn.completed | waiting | silent | failed | superseded
```

Planner `wait` 到期会恢复候选；休眠周期到期只为仍有积压的 scope 产生 `recheck`。两者都复用原有水位和开放 scope 约束，不把一次通知变成逐条回复保证。

这是破坏式协议更新。旧 candidate、turn context、Arousal 数据库事实和模块配置不提供双读或迁移适配，升级前需要重置。
