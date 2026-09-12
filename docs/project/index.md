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
- Server 只从全局 selected Profile 读取 PostgreSQL 17 与全部持久 runtime 配置；开发命令可管理固定的本地实例。
  :::

::: timeline 持久化信息 DAG

- Core 以 `informationId` 作为运行事实的唯一身份，先提交信息账本，再向当前消费者并发广播。
- 入站、过滤、回复请求、LLM、assistant、投递与结果均以显式 Information Kind 和因果引用组成 DAG。
- 过滤通过注册下一 Kind；过滤拒绝只记录 `filter.decision`。
- 消费者、LLM 和投递失败都会保留为失败事实，已提交输入与其他消费者结果不会回滚。
  :::

::: timeline 配置、模型与审计

- 多 Profile Registry 支持创建、完整替换、显式全局选择和受限删除。
- Server 每次启动生成新的 Gateway Token，并在成功监听后打印带 fragment 的完整 Web UI 访问链接。
- Vercel AI SDK Core 统一模型调用、结构化输出和错误分类。
- PostgreSQL 17 信息账本与结构化日志记录持久运行事实。
  :::

::: timeline 信息原子与异步账本

- InformationAtom、显式引用与可封锁 Kind Registry 已实现。
- InformationLedger 提供异步 append、get、getMany 与反向引用 query。
- PostgreSQL 17 生产仓储以追加式事务维护原子、引用和 Kind 集合；PGlite 仅用于普通测试。
- 持久 outbox 将日志作为提交后的单向投影，失败任务保留待重试。
  :::

## 当前明确没有

**持久订阅与离线补投** — 广播只面向当前订阅者；后来注册的消费者不接收历史原子。

**工作队列、消费者优先级与自动重试** — 消费者按当前快照并发执行。失败记录为 `consumer.failed`、LLM failed 或 delivery failed，不在 Core 中静默重试。

**模块热更新与沙箱** — 模块是受信任的同进程代码。

**隐式对话分组** — Core 不按用户、群聊、来源或 HTTP 字段建立 session。

**Web 回复读取通道** — 消息 API 只返回 `202 accepted`，没有回复查询或 SSE。

**旧数据自动迁移** — 旧 SQLite 与旧配置索引会被拒绝，不会自动删除或转换。

## 后续实施顺序

### 已完成：#38 信息原子与 Kind Registry

定义只依赖 `informationId` 的不可变信息原子，通过 Kind 注册和校验不同载荷，并允许信息 ID 之间建立显式类型引用。

### 已完成：#39 异步账本、PostgreSQL 与日志投影

InformationLedger 已改为异步端口；PostgreSQL 17 实现追加式存储、引用约束和持久日志 outbox。日志从已提交原子单向投影，失败不回滚事实，Server 主链已经使用该账本。

**旧 SQLite 数据自动迁移** — 旧 SQLite 文件与旧配置索引不会自动读取、转换、合并或删除。

## 后续方向

### Memory 底座与后续分层

独立消息 Memory、Unicode 2-gram 稀疏召回和 first-party Prompt 接入已由 #74 实现。Memory 行不属于 Information Ledger；检索命中会重新加载原始 inbound atom，使 provenance 保持为不可变消息。默认回复执行全局召回，并排除当前消息和未来消息。

#78 负责可恢复的逐消息写入，不等待 agent reply，也不拼装回合。#90 负责可替换的认知 provider 与许可证决策，Kaguya 不自写事实演化启发式。#91 负责 pgvector、可恢复回填和稀疏/向量混合召回。周期调度与运行维护仍由 #80/#81 负责。

### PostgreSQL 运维演进

当前本地开发以固定 Docker-compatible PostgreSQL 17 实例验收，外部数据库由 Profile 文件显式配置。后续运维能力仍需保持不隐式删除容器、数据卷或用户 schema 的边界。

## 文档状态

当前静态站按 UI 设计、用户文档和开发者架构三层组织，并用根 README、`CONTRIBUTING.md`、Server/Runtime 代码、schema 与 package README 核对事实。历史文档、日期化方案、实施记录和旧站资源已整体移至[冻结归档](https://github.com/posanbu/Kaguya/tree/3622c77bc3d3b9a947bb76082164095284cf6edb)，仅供审计，不描述当前行为。主分支与文档站只维护当前内容，旧 URL 不提供兼容跳转。

后续代码 PR 如果改变公开行为，应在同一 PR 更新对应页面，避免静态站再次与实现脱节。

## 参与方式

先通过 GitHub Issue 确认范围，在独立分支进行小步修改，并运行受影响测试与根质量检查。开发细节见[参与贡献](../developers/contributing)。
