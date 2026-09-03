---
title: 项目状态与路线图
description: Kaguya 当前已实现能力、明确边界和后续演进顺序。
---

# 项目状态与路线图

本页只把有代码、测试或可追踪设计作为当前事实。路线图来自仓库现有后续工作说明，接口和交付时间仍可能在 Issue 与 PR 中调整。

## 当前已实现

::: timeline 统一运行入口
- `apps/server` 在同一 Fastify 实例提供 Web UI、HTTP API 与可选 NapCat。
- 开发模式内嵌 Vite middleware，生产模式提供构建后的静态资源。
:::

::: timeline 事件与模块 Runtime
- 入站消息落库后广播 `message.ingested`。
- ModuleHost 支持广播、定向事件和不可改写的因果字段。
- 默认演示链完成 filter、LLM reply 与显式 outbound request。
:::

::: timeline 配置、模型与审计
- 多 Profile Registry 支持创建、完整替换、显式全局选择和受限删除。
- Server 未设置 Gateway Token 时自动生成，Web UI 页面加载时自动取得。
- Vercel AI SDK Core 统一模型调用、结构化输出和错误分类。
- SQLite 与结构化日志记录消息、LLM trace 和出站状态。
:::

::: timeline 信息原子与异步账本基础设施
- InformationAtom、显式引用与可封锁 Kind Registry 已实现。
- InformationLedger 提供异步 append、get、getMany 与反向引用 query。
- PostgreSQL/PGlite 仓储以追加式事务维护原子、引用和 Kind 集合。
- 持久 outbox 将日志作为提交后的单向投影，失败任务保留待重试。
:::

## 当前明确没有

**持久事件队列** — 事件仍在进程内分发。

**自动重试与去重** — transport 或模块失败会被审计，但 Core 不静默重试。

**模块热更新与沙箱** — 模块是受信任的同进程代码。

**隐式对话分组** — Core 不按用户、群聊、来源或 HTTP 字段建立 session。

**Web 回复读取通道** — 消息 API 只返回 `202 accepted`，没有回复查询或 SSE。

**旧数据自动迁移** — 旧 SQLite 与旧配置索引会被拒绝，不会自动删除或转换。

**InformationLedger 接入主 Runtime** — 新账本基础设施尚未替换 `apps/server` 当前的 SQLite 数据路径。

## 后续实施顺序

### 已完成：#38 信息原子与 Kind Registry

定义只依赖 `informationId` 的不可变信息原子，通过 Kind 注册和校验不同载荷，并允许信息 ID 之间建立显式类型引用。

### 已完成：#39 异步账本、PostgreSQL 与日志投影

InformationLedger 已改为异步端口；PostgreSQL/PGlite 实现追加式存储、引用约束和持久日志 outbox。日志从已提交原子单向投影，失败不回滚事实。该子系统尚未接入当前 Server 主链。

### #40 Core DAG 与模块 SDK

模块显式订阅输入 Kind、产生输出 Kind。Core 只负责类型校验、DAG 调度、因果关系与失败传播，不自动推导处理链。

### #41 Selector、Prompt 与 Memory

Selector 通过显式信息引用选择上下文；Prompt provenance 与 Memory 建立在信息原子和账本上，不恢复隐式分组。

### 主 Runtime 接入与迁移

在信息 Kind、DAG 与模块边界稳定后，把 `apps/server` 从旧 SQLite 消息路径迁移到 PostgreSQL 账本，同时明确兼容与数据迁移策略。

## 文档状态

当前静态站按 UI 设计、用户文档和开发者架构三层组织，并用根 README、`CONTRIBUTING.md`、Server/Runtime 代码、schema 与 package README 核对事实。旧 `zh/` 和 `ours/` 资料仍留在仓库中用于核对，但不参与公开构建。

后续代码 PR 如果改变公开行为，应在同一 PR 更新对应页面，避免静态站再次与实现脱节。

## 参与方式

先通过 GitHub Issue 确认范围，在独立分支进行小步修改，并运行受影响测试与根质量检查。开发细节见[参与贡献](../developers/contributing)。
