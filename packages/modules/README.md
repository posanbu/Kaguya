# `@kaguya/modules`

## Heartbeat activation

`heartbeatModule`（定义 ID：`agent.heartbeat.short`）是一个可选的短心跳模块。它依赖 `oneShotScheduleCapability`，消费 inbound text、`agent.wait.requested` 和 one-shot due，产生 heartbeat schedule/terminal 以及 `agent.turn.candidate`。模块加入 Catalog，但不加入默认 `firstPartyModuleActivations`；只有显式 activation 才会运行。

Heartbeat payload 使用绝对时间和稳定 destination scope。消息延期通过 one-shot replacement 合并，进程重启由 durable scheduler 恢复。模块本身不唤醒对话 Agent、不调用 LLM，也不发送平台消息。
