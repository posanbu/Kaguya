---
title: 参考资料
description: Kaguya HTTP、配置、信息 Kind 与存储边界的查询入口。
---

# 参考资料

本分区记录可以直接从当前代码和 schema 核对的事实。使用教程放在[使用指南](../guide/)，设计理由放在[运行时架构](../developers/architecture)。

## 可用参考

### HTTP API

[HTTP API](./http-api)记录统一 Server 的路由、Bearer 认证、全局 Profile 管理、消息请求/响应与错误码。

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

每个 Core 事实只使用 `informationId`。派生原子用 `core:caused-by` 指向直接输入，并继承 `core:context`；`core.llm.*` 与 `core.delivery.*` 的结果还用 `core:status-of` 指向所对应的请求。

## 数据与回放边界

**PostgreSQL information ledger** — 由 `KAGUYA_DATABASE_URL` 连接，保存 append-only 原子、引用、Kind 和日志投影 outbox。没有 SQLite runtime 数据库或平行消息/trace/outbound 表。

**Profile Registry** — 默认位于 `.data/kaguya-config`，保存 Profile metadata 和显式 `selectedProfileId`。其中可能包含明文凭据，必须按敏感数据保护。

账本允许按显式引用读取 DAG，但没有持久订阅、离线补投、工作队列或自动重试。旧 SQLite 数据和旧配置索引不会自动迁移、合并、转换或删除。
