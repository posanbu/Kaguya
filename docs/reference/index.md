---
title: 参考资料
description: Kaguya HTTP、配置、事件与存储边界的查询入口。
---

# 参考资料

本分区记录可以直接从当前代码和 schema 核对的事实。使用教程放在[使用指南](../guide/)，设计理由放在[运行时架构](../developers/architecture)。

## 可用参考

### HTTP API

[HTTP API](./http-api)记录统一 Server 的路由、Bearer 认证、请求/响应、错误码和 requestId 规则。

### Profile API

[Profile API](./profile-api)记录多 Profile Registry 的创建、完整替换、选择和删除契约。

### 环境变量

[环境变量](./environment-variables)记录 Server、白名单、NapCat 和日志配置，以及会导致启动失败的旧变量。

## 核心事件

**`message.ingested`** — 入站消息通过白名单并落库后广播给模块。

**`reply.requested`** — Filter 模块定向请求某个模块实例生成回复。

**`message.outbound.requested`** — 模块显式指定 adapter、platform、destination 与消息内容，请求 Runtime 投递。

**`message.outbound.delivered`** — transport 成功，出站审计已经更新为 delivered。

**`message.outbound.failed`** — transport 失败，事件只携带稳定错误文本，不暴露底层凭据。

**`llm.requested / completed / failed`** — LLM execution 生命周期事件，关联 prompt kind、modelId、workflowId 与 nodeId。

## 关联标识

**requestId** — Fastify 请求标识，可由合法 `X-Request-Id` 提供，否则生成 UUID。

**traceId** — 一次 Runtime dispatch 的主关联标识。Web trace 使用 `web:${requestId}`。

**eventId** — 单个事件实例标识。

**causationEventId / rootEventId** — 记录逐级原因与根事件，构成不可被模块 metadata 改写的因果链。

**moduleDefinitionId / moduleInstanceId** — 标记产生事件的模块定义和实例。

这些字段用于观测与审计，不表示用户会话、权限或上下文隔离。

## 数据存储

**`.data/kaguya.sqlite`** — 默认 Runtime SQLite，保存规范化消息、LLM trace 和出站审计。

**`.data/kaguya-demo.sqlite`** — `pnpm demo` 的隔离数据库。

**`.data/kaguya-config`** — 默认 profile store，包含明文凭据，必须按敏感数据保护。

**PostgreSQL / PGlite 信息账本** — 追加式 InformationAtom、引用与日志 outbox 已作为分阶段子系统实现，但尚未接入当前 Server 的 SQLite 主 Runtime；参见[信息账本](../developers/information-ledger)。

旧数据库和旧配置格式会被明确拒绝，不会自动迁移、合并或删除。
