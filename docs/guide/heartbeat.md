# 短心跳的延期与恢复

短心跳是一个显式激活的 Information Module。它把入站消息或 `agent.wait.requested` 转换为 durable one-shot schedule，到期后记录 `agent.heartbeat.fired` 与 `agent.turn.candidate`。模块不调用 LLM、Runtime turn 或平台 transport，因此 candidate 只是交给后续核心层处理的事实。

## 配置与生命周期

在 Runtime 的 module activations 中加入 `agent.heartbeat.short` 即可启用。`messageDebounceMs` 控制同一 destination 的消息合并窗口；`maxReplacementAttempts` 限制替换重试。未激活时不会安装 durable subscription，也不会创建后台计时器。

schedule 使用绝对 `dueAt`、稳定 `scopeKey` 和按到达顺序保存的 `sourceInformationIds`。新消息发现同 scope 的 open schedule 后，使用 one-shot `replace` 原子替换旧 schedule，并为旧 heartbeat 写入 `superseded` terminal。旧 schedule 不会再次触发 candidate。

Runtime 关闭时不写入 cancelled。one-shot scheduler 的 open arm 保留在数据库中，重启时恢复并处理 overdue schedule；因此进程短暂停机不会丢失 wait 或 debounce 事实。

`wakeOnMessage` 为 `true` 时，消息会替换 wait deadline 并重新计算 debounce；为 `false` 时保留原 deadline，但仍把新消息引用并入新的 heartbeat 事实。达到 `attempt` 或 `totalWaitBudget` 后，模块不会自动制造下一次 wait。

## 事实链

```text
inbound / agent.wait.requested
  -> agent.heartbeat.scheduled
  -> core.schedule.one-shot.requested
  -> core.schedule.one-shot.due
  -> agent.heartbeat.fired | agent.heartbeat.superseded
  -> agent.turn.candidate
```

所有终态均通过幂等 terminal API 写入；重复投递只会得到已有终态，不会产生第二个 candidate。
