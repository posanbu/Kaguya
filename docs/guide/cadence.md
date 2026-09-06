# 让维护任务沿着固定时间边界恢复

Durable cadence 用于周期性维护，而不是对话消息调度。调度器把每个
周期边界写成 Information Atom；即使进程停止，重启后仍能根据原始
`anchor` 计算已经过去的窗口。窗口不会因为上一次任务完成较晚而漂移。

## 配置方式

Runtime 通过 `cadence.definitions` 显式启用维护 cadence。每项配置需要
提供 `anchor`、正整数 `intervalMs`、稳定的 `activationRevision` 和
不透明的 `scopeKey`。未提供该配置时，Runtime 不创建 cadence 定义，
已有日志投影的即时路径保持不变。

## 补跑与去重

首版 policy 为 `coalesce.v1`。例如六小时周期在停机期间错过三个边界，
恢复时只产生一个 tick；其 payload 同时记录最早边界、最新边界和
`missedCount`。tick 的唯一键是：

```text
definitionInformationId:windowIndex
```

因此多个 Runtime 实例可以并发轮询，但同一窗口最多提交一个 tick。

## 日志投影维护链

日志投影 reconciliation 是首个真实维护消费者。tick 先产生
`maintenance.projection.reconciliation.requested`，再由可靠消费者按
固定批次调用日志投影 runner，最后写入 `completed` 或 `failed` 终态。
这些终态描述本次维护执行，不改变原始 Information Atom，也不会触发
LLM、平台适配器或聊天 Agent。

停止 Runtime 时会先停止 cadence 轮询，再等待可靠消费 drain。未来窗口
不会提前写入；下一次启动会重新计算 overdue 窗口。
