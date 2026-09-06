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

[环境变量](./environment-variables)记录 PostgreSQL、Server、白名单、NapCat 和日志配置，以及会导致启动失败的旧变量。

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

**PostgreSQL information ledger** — 由 `KAGUYA_DATABASE_URL` 连接。迁移在事务中执行，payload 为 `JSONB`，Kind、原子和显式引用由外键保护；原子、引用和日志投影 outbox 原子写入。PGlite 与 CI 的真实 PostgreSQL 服务运行同一份账本契约。没有 SQLite runtime 数据库或平行消息/trace/outbound 表。

**moduleDefinitionId / moduleInstanceId** — 标记产生事件的模块定义和实例。

这些字段用于观测与审计，不表示用户会话、权限或上下文隔离。

## 数据存储

**`.data/kaguya.sqlite`** — 默认 Runtime SQLite，保存规范化消息、LLM trace 和出站审计。

**`.data/kaguya-demo.sqlite`** — `pnpm demo` 的隔离数据库。

**`.data/kaguya-config`** — 默认 profile store，包含明文凭据，必须按敏感数据保护。

**PostgreSQL / PGlite 信息账本** — 追加式 InformationAtom、引用与日志 outbox 已作为分阶段子系统实现，但尚未接入当前 Server 的 SQLite 主 Runtime；参见[信息账本](../developers/information-ledger)。

旧数据库和旧配置格式会被明确拒绝，不会自动迁移、合并或删除。
