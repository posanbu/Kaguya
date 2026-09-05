---
title: 项目状态与路线图
description: Kaguya 当前已实现能力、明确边界和后续演进方向。
---

# 项目状态与路线图

本页只把有代码和测试支持的行为作为当前事实。后续方向可能在 Issue 与 PR 中调整，不应被当作已交付接口。

## 当前已实现

::: timeline 统一运行入口

- `apps/server` 在同一 Fastify 实例提供 Web UI、HTTP API 与可选 NapCat。
- 开发模式内嵌 Vite middleware，生产模式提供构建后的静态资源。
- Server 以必填 `KAGUYA_DATABASE_URL` 使用 PostgreSQL，并在启动时只解析全局 `selectedProfileId`。
  :::

::: timeline 持久化信息 DAG

- Core 以 `informationId` 作为运行事实的唯一身份，先提交信息账本，再向当前消费者并发广播。
- 入站、过滤、回复请求、LLM、assistant、投递与结果均以显式 Information Kind 和因果引用组成 DAG。
- 过滤通过注册下一 Kind；过滤拒绝只记录 `filter.decision`。
- 消费者、LLM 和投递失败都会保留为失败事实，已提交输入与其他消费者结果不会回滚。
  :::

::: timeline 配置与审计

- Profile Registry 管理一组 Profile 与唯一的 `selectedProfileId`；模块与消息没有 Profile 覆盖入口。
- PostgreSQL information ledger 保存 append-only 原子与引用；日志投影是提交后的观察者。
- payload 使用 `JSONB`，原子与显式引用由外键保护；原子、引用和日志 outbox 在同一事务写入。
- PGlite 与 CI 的真实 PostgreSQL 服务共用账本契约、索引和重连验收。
- Web、OneBot/NapCat adapter 只正规化平台内容并提交窄 `InformationIngress`。
  :::

## 当前明确没有

**持久订阅与离线补投** — 广播只面向当前订阅者；后来注册的消费者不接收历史原子。

**工作队列、消费者优先级与自动重试** — 消费者按当前快照并发执行。失败记录为 `consumer.failed`、LLM failed 或 delivery failed，不在 Core 中静默重试。

**模块热更新与沙箱** — 模块是受信任的同进程代码。

**隐式对话分组** — Core 不按用户、群聊、来源或 HTTP 字段建立 session。

**Web 回复读取通道** — 消息 API 返回 `202 accepted`，没有回复查询或 SSE。

**旧 SQLite 数据自动迁移** — 旧 SQLite 文件与旧配置索引不会自动读取、转换、合并或删除。

## 后续方向

### Selector、Prompt 与 Memory

后续上下文选择、Prompt provenance 与 Memory 若实现，应建立在已持久化的信息原子和显式引用上，不恢复隐式会话或事件身份。

### 额外的可靠性能力

若未来引入回放、队列或重试，必须明确其消费语义、失败边界与用户可见状态，并以 ledger 中的 `informationId` 为边界；这些能力目前尚未提供。

## 文档状态

当前静态站已经用根 README、Server/Runtime 代码和 package public API 填充安装、配置、Web UI、架构、API 与环境变量页面。`docs/ours/` 与 `docs/zh/` 是不参与公开构建的历史核对资料，不代表当前接口。

后续代码 PR 如果改变公开行为，应在同一 PR 更新对应页面，避免静态站再次与实现脱节。

## 参与方式

先通过 GitHub Issue 确认范围，在独立分支进行小步修改，并运行受影响测试与根质量检查。开发细节见[参与贡献](../developers/contributing)。
