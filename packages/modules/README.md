# `@kaguya/modules`

## 一方模块目录

每个受信的一方模块放在 `src/first-party/<module>/index.ts`，测试与模块放在同一目录。多个模块共享的 Information Kind 统一定义在 `src/first-party/information-kinds.ts`；只服务于回复模块的上下文辅助代码放在 `src/first-party/llm-reply/`。包根 `src/index.ts` 负责稳定的公共导出，调用方不应依赖这些内部路径。

`src/first-party/catalog.ts` 必须显式导入并注册每一个受信模块。Runtime 不扫描目录，也不会因为新增一方文件而自动发现或激活模块。Manifest 的 `consumes` 与 `produces` 是 Runtime 收集模块 Kind 的唯一接口；Runtime、Engine 与 Scheduler 只单独注册自身拥有的基础 Kind。

模块 Manifest 必须提供非空的 `displayName` 与 `description`。每个 Information Kind 和 Prompt renderer 也必须提供非空的 `displayName` 与 `description`；renderer 还要声明稳定 `rendererId` 及适用的 `kinds`。Inspection 和后续 WebUI 直接使用这些字段，不能另行硬编码模块或 Kind 名称。

## Heartbeat 与 Heartflow

`heartbeatModule`（定义 ID：`agent.heartbeat.short`）依赖 `oneShotScheduleCapability`，消费 inbound text、`agent.wait.requested` 和 one-shot due，产生 heartbeat schedule/terminal 以及 `agent.turn.candidate`。`createHeartflowModule()` 使用 scope generation、identity barrier 和不可变多输入 context，把 candidate 推进为 speak、wait 或 silent，并为每个 turn 提交唯一终态。

`createFirstPartyModuleActivations("production")` 使用 1500 ms 去抖，`"test"` 使用 0 ms；两种 profile 都启用 Heartbeat 与 Heartflow。Heartbeat payload 使用绝对时间和稳定 destination scope。消息延期通过 one-shot replacement 合并，进程重启由 durable scheduler 恢复。

默认 Catalog 不含 always-reply、inbound-to-context 或 speech-to-reply 桥接。LLM reply 只接收 Heartflow 的 speak 分支，并沿 turn provenance 把 delivery terminal 交回 Heartflow 完成回合。
