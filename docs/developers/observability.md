---
title: Runtime 与 Information 可观测性
description: 阅读模块启动、模块诊断与持久 Information DAG 日志。
---

# Runtime 与 Information 可观测性

Kaguya 将可观测性分成三个命名空间，避免把生命周期、临时诊断和持久事实混成同一种日志：

- `runtime:modules` 是 Host 观察到的权威装配与启动状态，包括拓扑顺序、逐实例 starting/started、失败阶段和安全错误类型。
- `runtime:module:<definitionId>` 是模块声明的 best-effort 运行诊断。它不持久化，也不能作为业务事实。
- `runtime:information` 是已提交 Information Atom 经 log outbox 生成的持久事实投影。

## 按级别展开 DAG

默认 `info` 显示业务终态和每轮 `turn.decision` 摘要；`debug` 显示排障所需的主要内部节点；完整 DAG 的机械节点使用 `trace`。Pretty 输出把完整 ID 缩成 8 个字符，并把引用显示成 `relation:短ID`；JSON 始终保留完整 `informationId` 与完整 `references`。

```dotenv
KAGUYA_LOG_LEVEL=info
KAGUYA_LOG_LEVELS=runtime:information=trace
```

这不是交互式折叠。开启 debug 后，每个带 detail policy 的 Atom 先输出原有摘要，再紧邻输出同一 `informationId` 的 `detail: true` 记录。

## Prompt 显示

`core.model.task.requested` 的 info 摘要包含 task/version、activation、tier、实际 provider/model、Prompt 字符数、variable 数和最多 168 个 Unicode 字符的 `promptPreview`。debug detail 额外包含完整 Prompt 以及按模块声明顺序排列的 variable provenance、informationIds 与 digest。Pretty 使用缩进多行展示；JSON 把相同数据保存在 `promptFull` 和 `promptVariables` 字段。

```dotenv
# 只展开 Information DAG 和完整 Prompt
KAGUYA_LOG_LEVELS=runtime:information=debug

# 只展开一个模块的临时诊断
KAGUYA_LOG_LEVELS=runtime:module:agent.message-composer=debug
```

::: warning 内容留存
Prompt preview、入站预览和 assistant 预览在 info 可见；完整 Prompt 只在 debug 可见。已识别的凭据赋值、连接 URL 和私钥块仍会被替换。debug 内容会进入终端或 JSON destination，生产启用前必须确认访问权限、留存周期和下游采集策略。
:::

## 模块诊断边界

模块用 `defineModuleDiagnostic()` 声明固定 event、消息、级别、严格 payload schema、主投影与可选 debug detail，再把 definition 列入 manifest 的 `diagnostics`。create、start 和 handler 都可调用 `context.report(definition, payload)`。Host 自动添加 definitionId、instanceId；handler 还会添加 source 与 runtime context informationId。

未声明 definition、schema 错误、投影错误或 observer 错误只生成脱敏的 `module.diagnostic.rejected`，不得使模块启动或业务 handler 失败。已经形成 Atom 的成功结果应由 kind log policy 投影，避免再发一条临时成功诊断。

模块可实现 `describeStartup()`，在 `start()` 成功后返回一句状态和少量安全 JSON 字段。描述无效或抛错不会否定 Host 的 `module.started`，只会追加 `module.status.failed`。

## Gateway / Adapter

Host 先提交内存快照，再记录状态。`server.started` 包含 `runtimeReady`、`adapterHostState` 和 `degradationReasons`。`GET /api/v1/adapters/status` 使用 management token，按 adapterId 排序返回安全状态；`/healthz` 在降级时仍返回 200。

NapCat 的 starting、真实 WebSocket open 后的 connected、disconnected、stopped、disabled 为 info；connecting、reconnect scheduled、stopping 为 debug；连接失败及安全错误类别为 warn。attempt、nextRetryAt 等失效字段随状态转换清除。

每条入站消息只记录一个 Adapter 终态：`napcat.inbound.submitted`、`napcat.inbound.filtered` 或 `napcat.inbound.failed`，Web 同理。终态在 info 输出完整 `messageText` 与来源元数据；submitted 在收到 Runtime 回执时携带 `rootInformationId`。对应的 `core.message.inbound.text` Atom 仅在 `trace` 输出。raw frame、连接 URL、token 和凭据不作为诊断字段输出；消息不可提交时不缓存或重放。

::: warning 完整正文留存
info 日志包含完整用户消息，可能含个人资料或用户主动发送的敏感内容。应限制日志访问并设置适当保留期限；删除数据库消息不会自动删除日志、备份或转发副本。debug 还可能展开现有 Runtime Prompt 详情。
:::

本地 selected `default` Profile 使用 debug / pretty；完整 Information DAG 需要显式启用 `runtime:information=trace`。该修改不改变全局默认日志级别。
