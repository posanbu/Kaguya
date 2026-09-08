---
title: 参考资料
description: Kaguya HTTP、配置、信息 Kind 与存储边界的查询入口。
---

# 参考资料

本分区记录可以直接从当前代码和 schema 核对的事实。使用教程放在[使用指南](../guide/)，设计理由放在[运行时架构](../developers/architecture)。

## 可用参考

### HTTP API

[HTTP API](./http-api)记录统一 Server 的路由、Bearer 认证、全局 Profile 管理、消息请求/响应与错误码。

### Profile API

[Profile API](./profile-api)记录多 Profile Registry 的创建、完整替换、选择和删除契约。

### 环境变量

[环境变量与运行配置](./environment-variables)记录仅保留的配置根与 CI 测试变量、selected Profile runtime，以及会导致启动失败的旧变量。

## 核心信息 Kind

**`core.runtime.context`** — 一次 ingress 提交的 context 根原子；回执中的 `rootInformationId` 指向它。

**`core.message.inbound.text`** — 已被 Runtime 注册的正规化入站文本。

**`core.reply.requested`** — 过滤通过后显式注册的下一阶段请求。

**`filter.decision`** — 过滤拒绝事实，payload 固定包含 `accepted: false`、原因和过滤器定义 ID；它不承担定向路由。

**`core.llm.requested`、`core.llm.completed`、`core.llm.failed`** — LLM 生命周期事实。

**`core.message.assistant.text`** — LLM 完成后派生的 assistant 文本。

**`core.delivery.requested`、`core.delivery.delivered`、`core.delivery.failed`** — 平台投递请求与其结果事实。

**`consumer.failed`** — 某个消费者抛出或 reject 后的脱敏失败事实；它不会回滚输入或触发自动重试。

**traceId** — 一次 Runtime dispatch 的主关联标识。Web trace 使用 `web:${requestId}`。

## 数据与回放边界

**PostgreSQL 17 information ledger** — 由 selected Profile 的 `runtime.databaseUrl` 连接。迁移在事务中执行，payload 为 `JSONB`，Kind、原子和显式引用由外键保护；原子、引用和日志投影 outbox 原子写入。PGlite 只用于普通测试，开发与 CI 的真实数据库验收要求 PostgreSQL 17。

**moduleDefinitionId / moduleInstanceId** — 标记产生事件的模块定义和实例。

这些字段用于观测与审计，不表示用户会话、权限或上下文隔离。

## 数据存储

**`.data/kaguya-config`** — 默认 profile store，包含明文凭据，必须按敏感数据保护。

**`kaguya-postgres-17-data`** — 本地托管 PostgreSQL 17 的命名卷。普通停止、Server 退出和测试结束都不会删除它。

旧 SQLite 数据、旧配置格式和同名非 first-party PostgreSQL 容器会被明确拒绝，不会自动迁移、合并、重建或删除。
