# Model Task 设计

## 目标与边界

Model Task 是一次受宿主权限控制、可审计、可恢复的结构化模型调用封套。它接收调用方已经选定并由账本重新加载的 source/context atoms 和 compiled Prompt，校验任务身份、Prompt provenance、模型策略以及 provider 输出，然后把 requested 与唯一 terminal 事实交给信息账本。它不判断人物事实是否成立，不决定回复是否发送，也不直接写入 reply、memory 或其他业务 kind。

本设计依赖 #76 的 typed capability 与 #79 的可靠执行原语。#76 session 负责 `defineModuleCapability`、`context.use`、activation 和宿主权限校验；#79 session 负责 `registerOnce`、`commitTerminal`、claim fencing、durable delivery、重试和 shutdown 恢复。本 session 只消费这些契约，负责 Model Task 和 provider 边界，并迁移 reply 与一个结构化 person-fact 示例。

首版不实现 Workflow、tools、subagent、streaming、多模态、通用队列、缓存、自动 fallback 或 provider side effect exactly-once。模型调用发生重复时，业务结果仍只能提交一次；外部 provider 本身保持 at-least-once。

## 组件与公共接缝

模块通过 #76 提供的 capability token 取得窄接口，不接触 provider、模型密钥、数据库或裸 Runtime。稳定接缝为：

```ts
const modelTask = defineModuleCapability<ModelTaskCapability>(
  "kaguya:model-task",
  1,
);

interface ModelTaskCapability {
  execute<TOutput extends JsonObject>(
    request: ModelTaskRequest<TOutput>,
  ): Promise<ModelTaskResult<TOutput>>;
  cancel(request: ModelTaskCancellation): Promise<ModelTaskResult<never>>;
}
```

`ModelTaskRequest` 至少包含：`taskId`、`taskVersion`、`outputSchema`、稳定 `sourceInformationId`、按 selector 顺序排列的 `contextAtoms`、`compiledPrompt`、宿主批准的 tier/policy、显式 `ModuleActivationProvenance`，以及可选的执行 signal。模块通过 #76 的 `context.use(modelTaskCapability)` 取得 capability；调用方用自己的 schema 获得 `TOutput`，但不把 `reply | memory | person-fact` 做成中央联合类型。

provider 端只接收已解析的 model handle、modelId、compiled Prompt、task output schema 和 AbortSignal，返回 JSON 输出、规范化 usage 与 duration。provider 适配器不暴露 secret，也不在本层做隐式重试；有界重试只由 #79 durable runner 负责。

## 身份、持久化与数据流

任务定义身份是 `(taskId, taskVersion)`，它不等于一次执行的身份。Model Task 为去重计算稳定 fingerprint：

```text
fingerprint = canonical(taskId, taskVersion,
  sourceInformationId,
  prompt.kind,
  ordered prompt provenance entries,
  canonical selection policy)
```

provenance entry 至少保留 fragmentId、informationId、source、priority 和 contentDigest；有序序列和 selection policy 都参与 fingerprint，临时 module instance ID 不参与。`registerOnce(operation, fingerprint, ...)` 负责在唯一槽中创建或复用 requested informationId，并返回实际赢家。

requested atom 记录 task/version、source 引用、Prompt provenance、解析后的 model/activation 审计信息和 selection policy；Prompt 正文可留在受控账本 payload 中，但日志、metrics 和 inspection 不输出正文。终态使用同一个 terminal group，并以 requested informationId 为 subject：`commitTerminal(group, requestedInformationId, ...)` 原子竞争 completed、failed、cancelled，返回已经提交的赢家。调用方只接受该赢家；迟到 provider 输出不能越过 terminal guard。

每次 execute 的顺序是：校验 task 与 policy → 按 informationId 重新加载 context atoms → 比较 selected ID/order 与 Prompt provenance → `registerOnce` requested → 检查已有 terminal → 调用 provider → 校验输出 schema → `commitTerminal` completed；provider 错误、schema 错误和显式业务取消分别提交脱敏 failed/cancelled。若 requested 已存在且已有 terminal，则不调用 provider，直接返回赢家。

## 取消、恢复与错误处理

业务取消必须通过显式 cancellation 请求参与 terminal 竞争。传给 provider 的 AbortSignal 可能来自业务取消、shutdown 或 lease expiry；后两者不得自动产生业务 cancelled。shutdown/lease 由 #79 释放 claim 并保留 requested，恢复后重投；provider 忽略 abort 的迟到结果仍必须经 `commitTerminal` fencing。

输出 schema 校验失败只能产生 failed terminal，未校验值不得出现在 `ModelTaskResult`。并发调用若另一方已经提交 failed 或 cancelled，当前调用返回该赢家状态，不把自己的 output 或原始 provider error 交给业务模块。错误原文只保留在受控异常链或 provider 边界，不写入 atom payload、日志或 metrics；持久化错误 payload 只含稳定 error type/kind 和通用 message。

## 业务迁移

reply 模块保留自己的 prompt compiler、outbound 选择和 assistant/delivery 业务事实，只把旧 reply-only executor 替换为 `ModelTaskCapability.execute`，source 可以是当前 reply atom。结构化 person-fact 示例使用同一 capability、独立 taskId/version 和非 reply source informationId，输出先过任务 schema，再由调用方决定是否注册 person-fact 业务 atom。不会引入完整记忆系统，也不增加兼容 adapter 或双写路径。

## 验收策略

测试按风险从窄到宽覆盖：

- provider 单次调用收到 AbortSignal 和任务 output schema，输出 schema 失败时 provider 结果不抵达调用方；
- reply 与 person-fact 使用同一 capability，person-fact 使用非 reply source；非法 tier/policy、source reload 缺失、provenance 错位均在 provider 前拒绝；
- 相同 fingerprint 的重投与并发只产生一个 requested identity 和一个 terminal，返回值遵循实际赢家；业务取消后迟到 completion 无法获胜；
- 真实 PostgreSQL 测试覆盖 requested 提交后、provider 返回后、terminal 提交后至 ack 前的崩溃窗口，并验证 shutdown 后可恢复；
- 审计引用可从 terminal 追溯到 requested、source、Prompt、task、resolved model 与 activation；日志/metrics/inspection 不含 Prompt、输出正文、凭据或 provider 原始错误。

这些测试依赖 #79 的真实持久化实现；fixture 只用于纯协议和 schema 单元测试，不能单独宣称崩溃恢复验收通过。
