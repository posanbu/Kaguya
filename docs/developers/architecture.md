---
title: 运行时架构
description: Kaguya 统一 Server、持久化信息 DAG、模块与数据边界。
---

# 运行时架构

Kaguya 使用一个长期运行进程、一个 composition root 和一个共享 Runtime。`apps/server` 负责读取配置、冻结全局 Profile、连接数据库并装配 HTTP/Web/NapCat；`@kaguya/runtime` 负责唯一的 `InformationIngress`、信息 DAG、LLM 生命周期和投递结果。

Core 中每项运行事实都是不可变 `InformationAtom`，且只以 `informationId` 作为身份。外部平台消息 ID、HTTP request ID、用户与群组 ID 仍可作为领域数据，但它们不构成 Core 身份，也不建立 session 或隐式上下文隔离。

## 运行形态

```mermaid
flowchart LR
  Browser[浏览器 / Web UI] --> Server[apps/server / Fastify]
  NapCat[NapCat / OneBot] --> Adapter[平台适配器]
  Server --> WebAdapter[Web 平台适配器]
  WebAdapter --> Runtime[KaguyaRuntime]
  Adapter --> Runtime
  Runtime --> DB[(PostgreSQL 17)]
  Runtime --> Core[InformationCore]
  Core --> Host[ModuleHost]
  Host --> Modules[Heartbeat / Heartflow / LLM / 自定义模块]
  Modules --> LLM[LLM execution port]
  Modules --> Outbound[message.outbound.requested]
  Outbound --> Runtime
  Runtime --> Transport[Outbound transport registry]
```

开发模式把 Vite middleware 与 HMR 挂在 Fastify 内；生产模式由同一实例提供 `apps/web/dist`。Web 消息也先规范化为平台 `web`、adapter `web.ui.main` 的入站消息，再异步交给 Runtime。NapCat 是可选 ingress 与 transport，连接失败不会停止 HTTP 服务或改变 `/healthz`。

## 持久化优先的信息流

`InformationCore.register()` 是唯一的原子写入入口。它生成信息原子并完成 Kind、payload 与引用校验，提交 PostgreSQL 账本；提交成功后，Core 取得该 Kind 的当前消费者快照并并发执行消费者。

```mermaid
flowchart LR
  External[Web 或平台输入] --> Normalize[Gateway / adapter 正规化]
  Normalize --> Ingress[InformationIngress.submit]
  Ingress --> Context[core.runtime.context]
  Context --> Inbound[core.message.inbound.text]
  Inbound --> Persist[校验并提交 PostgreSQL]
  Persist --> Broadcast[当前消费者并发广播]
  Broadcast --> Identity[Identity terminal]
  Broadcast --> Heartbeat[Durable heartbeat]
  Heartbeat --> Candidate[agent.turn.candidate]
  Candidate --> Heartflow[Generational claim / identity barrier]
  Identity --> Heartflow
  Heartflow --> Turn[Immutable turn context]
  Turn --> Speech[Speak / wait / silent decision]
  Speech --> Heartflow
  Heartflow -->|speak| Reply[core.reply.requested]
  Heartflow -->|wait| Wait[agent.wait.requested]
  Heartflow -->|silent| Silent[agent.turn.silent]
  Reply --> LLM[Model Task / assistant / delivery]
  Broadcast -->|消费者失败| Failed[consumer.failed]
```

提交失败时不会广播；提交成功后，即使没有消费者，原子也保留。广播只面向注册瞬间的消费者快照，多个消费者独立并发执行，不存在优先级、拦截器、短路或定向派发。后来注册的消费者不会收到历史原子。

Web HTTP 请求只允许文本和 requestId。Web adapter 会补齐平台、sender 与 target 等规范字段；其他平台入站还包含经过 schema 校验的 adapter、平台消息 ID、self ID、destination、sender 和 mentions。adapter 原始 payload 不进入事件或持久化 metadata。

HTTP `202 accepted` 在 Web gateway 接收消息后立即返回；Runtime dispatch 在后台继续。该状态不证明事件链、模型调用或投递已经完成。

默认在线链由 Heartflow 以可重放事实推进：

```text
core.runtime.context
  -> core.message.inbound.text
  -> agent.person.context.completed
  -> agent.heartbeat.scheduled
  -> core.schedule.one-shot.requested
  -> core.schedule.one-shot.due
  -> agent.heartbeat.fired
  -> agent.turn.candidate
  -> agent.turn.claimed
  -> agent.turn.started
  -> agent.turn.context.completed
  -> agent.speech.decision
     -> speak: core.reply.requested -> core.model.task.* -> core.message.assistant.text
               -> core.delivery.requested -> core.delivery.delivered | core.delivery.failed
               -> agent.turn.completed | agent.turn.failed
               -> core.model.task.failed | cancelled -> agent.turn.failed
     -> wait: agent.wait.requested -> agent.turn.waiting -> 下一代 heartbeat
     -> silent: agent.turn.silent
```

同一 destination scope 的 claim 带单调 generation。新 candidate 若在旧 claim 作出 speech decision 前到达，会先赢得旧 claim 的 decision gate，再写入旧 turn 的 `superseded` 终态；旧分支不能继续产生 reply。Heartflow 等到 candidate 引用的每条 inbound 都具有 identity terminal，才冻结多输入 turn context。`speak`、`wait`、`silent` 只由 Heartflow 分派，默认链中没有 inbound 直达 turn context、always-reply 或 speech-to-reply 桥接旁路。

每条派生边都带有直接输入的 `core:caused-by` 引用，并继承唯一的 `core:context`。跨入站合并时，模块只能把 context 重定位到当前 handler 通过声明式 Selector 选出的 `core.runtime.context`。Model Task、消费者重试耗尽和投递失败都是账本事实；平台发送成功后注册 `core.delivery.delivered`，并由 Heartflow 写入唯一 turn terminal。

## 消费者失败不会回滚已提交事实

Server 启动时打开 Profile Registry，检查全局 selected Profile，并先验证数据库连接、PostgreSQL 17、migration 与 Runtime Kind。随后才为 light/heavy target 创建模型客户端。Provider key 只存在于权限保护的 Profile JSON、配置管理器和 provider factory，不进入模块 settings、信息原子、Prompt 或日志。AI 与数据库检查独立执行。下游不可用时，HTTP 和 Adapter 仍启动，Web 返回 503，NapCat 丢弃消息。完整流程见[配置生命周期](./configuration-lifecycle)。

`consumer.failed` 的消费者若再次失败，或失败事实无法提交，Core 只交给 bootstrap 诊断边界，不递归生成失败原子。因此系统没有自动重试，也没有内建工作队列。

## 配置、模型与数据边界

selected Profile 的 `runtime.databaseUrl` 是 PostgreSQL 连接真值，`databaseMode` 区分开发工具可管理的本地实例与完全外部的实例。旧 Profile 未声明 mode 时按 `external` 处理。Server 通过 `KaguyaDatabase.connect()` 建立连接并拒绝非 PostgreSQL 17；Runtime 启动时在一个数据库事务中执行可重复的迁移。`information_atoms.payload` 使用 `JSONB`，Kind、原子和显式引用由外键保护；原子、引用与日志投影 outbox 在同一事务写入，随后才由 outbox runner 投影日志。原子与引用由数据库触发器保持 append-only。旧 SQLite 数据不会自动迁移。

Profile Registry 维护一个全局 `selectedProfileId`。Server 在启动时只读取该 Profile 并构造共享 light/heavy 模型解析器；模块 settings、入站 payload 和信息原子不携带 `profileId`，也没有回退到其他 Profile、Provider 或模型的路径。

同一 Profile 还提供 host、port、Web 路径、CORS、可信代理、限流、日志、allowlist、Memory、平台与插件。应用环境只定位 `KAGUYA_CONFIG_ROOT`。Gateway Token 是每次启动生成的临时 capability，不写入 Profile。NapCat UI/API 直接读写 selected Profile 的平台条目；旧 `napcat.json` 和运行环境变量只触发脱敏迁移错误。

## 启动与关闭顺序

启动先读取基础配置并创建 AdapterHost，再独立检查 AI 与数据库。两者就绪时由 Host 注册 transport 并启动 Runtime；成功后一次性开放 ingress。随后启动 HTTP，再并发启动各 Adapter。下游失败仅使服务降级，Profile 不可读、基础配置无效或 HTTP 无法监听仍终止启动。

正常关闭先停止 ingress，等待 Runtime 在途 dispatch，停止 ModuleHost，再关闭数据库、Web 资源和 Logger。这个顺序避免新消息进入已经开始释放的基础设施。

## AdapterHost

HostedAdapter 定义身份、平台、可选 outbound transport、start/stop 和状态上报回调。Server 的 AdapterHost 统一负责生命周期、allowlist、入站日志、提交和内存快照。单个 Adapter failed 不改变 Host 的 running 状态。状态采用 lifecycle、connectivity、ingress 三个正交维度；connected 不代表可以处理消息，Web connectivity 固定为 not_applicable。

Runtime 绑定在启动时固定，修复后重启，不支持热绑定、缓存或重放。为兼容 Runtime 的既有约束，transport 在 Runtime start 前注册，ingress 在 start 成功后才开放。
