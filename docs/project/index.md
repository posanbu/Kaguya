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
- 信息模块 SDK 与 `InformationModuleHost` 已提供原子订阅、派生引用和并发消费者隔离；旧 EventBus 主链仍在渐进迁移。
:::

::: timeline 配置、模型与审计
- Profile store 管理 Provider 与 light/heavy 模型目标。
- Vercel AI SDK Core 统一模型调用、结构化输出和错误分类。
- SQLite 与结构化日志记录消息、LLM trace 和出站状态。
:::

## 当前明确没有

**持久事件队列** — 事件仍在进程内分发。

**自动重试与去重** — transport 或模块失败会被审计，但 Core 不静默重试。

**模块热更新与沙箱** — 模块是受信任的同进程代码。

**隐式对话分组** — Core 不按用户、群聊、来源或 HTTP 字段建立 session。

**Web 回复读取通道** — 消息 API 只返回 `202 accepted`，没有回复查询或 SSE。

**旧数据自动迁移** — 旧 SQLite 与旧配置索引会被拒绝，不会自动删除或转换。

## 后续实施顺序

### #38 信息原子与 Kind Registry

定义只依赖 `informationId` 的信息原子，通过 Kind 注册和校验不同载荷，并允许信息 ID 之间建立显式类型引用。

### #39 异步账本、SQLite 与日志投影

以追加式信息账本作为事实来源；SQLite 先实现存储抽象，日志从账本事件投影，不反向充当事实来源。

### #40 Core DAG 与模块 SDK

已完成信息模块 SDK、`InformationModuleHost` 和并发广播基础：模块可以显式订阅输入 Kind，并通过 Core 追加带有 `core:caused-by`、`core:context` 的输出原子。Runtime 入站、LLM、delivery 和失败原子仍待迁移，Issue 尚未整体完成。

### #41 Selector、Prompt 与 Memory

Selector 通过显式信息引用选择上下文；Prompt provenance 与 Memory 建立在信息原子和账本上，不恢复隐式分组。

### #42 PostgreSQL 切换

在存储抽象和账本语义稳定后把事实存储切换到 PostgreSQL，同时保持信息 ID、Kind、引用和投影语义。

## 文档状态

当前静态站已经用根 README、`CONTRIBUTING.md`、Server/Runtime 代码和 package README 填充安装、配置、Web UI、架构、API 与环境变量页面。旧 `zh/` 和 `ours/` 资料仍留在仓库中用于核对，但不参与公开构建。

后续代码 PR 如果改变公开行为，应在同一 PR 更新对应页面，避免静态站再次与实现脱节。

## 参与方式

先通过 GitHub Issue 确认范围，在独立分支进行小步修改，并运行受影响测试与根质量检查。开发细节见[参与贡献](../developers/contributing)。
