# `@kaguya/modules`

## Heartbeat 与 Heartflow

`heartbeatModule`（定义 ID：`agent.heartbeat.short`）依赖 `oneShotScheduleCapability`，消费 inbound text、`agent.wait.requested` 和 one-shot due，产生 heartbeat schedule/terminal 以及 `agent.turn.candidate`。`createHeartflowModule()` 使用 scope generation、identity barrier 和不可变多输入 context，把 candidate 推进为 speak、wait 或 silent，并为每个 turn 提交唯一终态。

`createFirstPartyModuleActivations("production")` 使用 1500 ms 去抖，`"test"` 使用 0 ms；两种 profile 都启用 Heartbeat 与 Heartflow。Heartbeat payload 使用绝对时间和稳定 destination scope。消息延期通过 one-shot replacement 合并，进程重启由 durable scheduler 恢复。

默认 Catalog 不含 always-reply、inbound-to-context 或 speech-to-reply 桥接。LLM reply 只接收 Heartflow 的 speak 分支，并沿 turn provenance 把 delivery terminal 交回 Heartflow 完成回合。
