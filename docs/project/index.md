---
title: 项目状态与路线图
description: Kaguya 当前已实现能力、明确边界和后续演进方向。
---

# 项目状态与路线图

本页只把有代码和测试支持的行为作为当前事实。后续方向可能在 Issue 与 PR 中调整，不应被当作已交付接口。

## 持续 Agent 故事的实现状态

项目以“持续感知、自然互动”为统一故事：相关 Information 到达可以唤醒 Agent，但 tick 不自动等于 turn；模块的订阅单位也不自动等于完整语义输入。完整约束见[持续 Agent 设计原则](../developers/continuous-agent)。

**已经对齐** — InformationAtom 已作为不可变证据保存；Heartbeat candidate 只携带通知与水位；Arousal 将被唤醒与完成观察分开；Heartflow 在 `observe` 后冻结多条输入；Planner 明确支持 `message | wait | silent`；Expression 使用多来源批次学习。

**部分对齐** — 当前 `agent.turn.*` 同时承载调度、观察和决策生命周期，名称仍容易被理解成逐消息问答；Heartflow 的多输入 turn context 接近 observation，但协议尚未采用这套领域术语。输入与输出按各自节奏推进目前是设计哲学，不是统一并发协议。

**领域设计已形成、实现待完成** — [持续情境契约](../developers/continuous/)承接 #241–#244，提出 scene 映射、冻结快照、独立消费进度、可修订经历与按能力划分的行动生命周期。设计方向已经人工确认，三个专题已给出共同契约、当前协议映射、取舍与验收时序，已由 [PR #251](https://github.com/posanbu/Kaguya/pull/251) 合入；#251 只增加设计文档，没有新增 Kind、数据库结构或运行行为。经历分段策略、协议字段和迁移细节由后续实现任务验证；不宣称已有统一取消、全双工语音或跨 tick 经历形成能力。

## 当前已实现

::: timeline 统一运行入口

- `apps/server` 在同一 Fastify 实例提供 Web UI、HTTP API 与可选 NapCat。
- 开发模式内嵌 Vite middleware，生产模式提供构建后的静态资源。
- Server 只从全局 selected Profile 读取 PostgreSQL 17 与全部持久 runtime 配置；开发命令可管理固定的本地实例。
  :::

::: timeline 持久化信息 DAG

- Core 以 `informationId` 作为运行事实的唯一身份。账本写入同时为已启用的持久订阅登记交付任务；在线广播与持久消费分别运行。
- 入站、过滤、消息意图、LLM、assistant、投递与结果均以显式 Information Kind 和因果引用组成 DAG。
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

## 当前能力的边界

**持久订阅与历史回填** — 已启用的 durable subscription 有持久队列，进程重启后可继续领取未完成交付。后来新注册的订阅不会自动回填注册前的全部原子；独立消费者的历史扫描与待处理范围仍需由模块明确建立。

**持续观察端口** — Runtime 提供显式依赖的 `agent:observation` v1，支持场景映射、有界冻结快照、独立进度与幂等确认。默认 Heartflow、Memory 尚未切换；生产启动回填、defer 到期检查与领域界面仍待接入。实现边界见[情境与观察](../developers/continuous/observation#持久观察端口-v1)。

**可靠任务与外部副作用** — 持久任务已有租约、失败重试和重试耗尽记录，唯一提交槽约束重复结果。它们不等于任意平台、工具或设备的副作用恰好发生一次；请求已发出但回执丢失时的核对、取消和补偿属于后续行动契约。

**模块热更新与沙箱** — 模块是受信任的同进程代码。

**隐式对话分组** — Core 不按用户、群聊、来源或 HTTP 字段建立 session。

**Web 回复读取通道** — `POST /api/v1/messages` 的 `202 accepted` 仅表示已接收；`GET /api/v1/messages` 按 `conversationId` 与游标读取持久消息和成功投递的回复。尚未成功投递的生成文本不会作为已送达回复展示；协议见 [HTTP API](../reference/http-api#公共路由)。

**旧数据自动迁移** — 旧 SQLite 与旧配置索引会被拒绝，不会自动删除或转换。

## 后续实施顺序

### 已完成：#38 信息原子与 Kind Registry

定义只依赖 `informationId` 的不可变信息原子，通过 Kind 注册和校验不同载荷，并允许信息 ID 之间建立显式类型引用。

### 已完成：#39 异步账本、PostgreSQL 与日志投影

InformationLedger 已改为异步端口；PostgreSQL 17 实现追加式存储、引用约束和持久日志 outbox。日志从已提交原子单向投影，失败不回滚事实，Server 主链已经使用该账本。

**旧 SQLite 数据自动迁移** — 旧 SQLite 文件与旧配置索引不会自动读取、转换、合并或删除。

## 后续方向

### Memory 底座与后续分层

独立消息 Memory、Unicode 2-gram 稀疏召回和 first-party Prompt 接入已由 #74 实现。Memory 行不属于 Information Ledger；检索命中会重新加载原始 inbound atom，使 provenance 保持为不可变消息。在线回合按冻结聊天范围召回，并排除当前消息和未来消息。

可靠逐消息写回、pgvector 可恢复回填与混合召回、可替换 Mem0 REST 认知层已接入。它们在 Profile 中显式启用，后台链不等待 reply，也不构造回合。认知以有界证据窗口产生快照，Kaguya 不自写演化启发式；部署及验收边界见 [Memory 认知层](../developers/memory.md)。周期调度与日志投影维护继续独立运行。

### PostgreSQL 运维演进

当前本地开发以固定 Docker-compatible PostgreSQL 17 实例验收，外部数据库由 Profile 文件显式配置。后续运维能力仍需保持不隐式删除容器、数据卷或用户 schema 的边界。

## 文档状态

当前静态站按 UI 设计、用户文档和开发者架构三层组织，并用根 README、`CONTRIBUTING.md`、Server/Runtime 代码、schema 与 package README 核对事实。历史文档、日期化方案、实施记录和旧站资源已整体移至[冻结归档](https://github.com/posanbu/Kaguya/tree/3622c77bc3d3b9a947bb76082164095284cf6edb)，仅供审计，不描述当前行为。主分支与文档站只维护当前内容，旧 URL 不提供兼容跳转。

后续代码 PR 如果改变公开行为，应在同一 PR 更新对应页面，避免静态站再次与实现脱节。

## 参与方式

先通过 GitHub Issue 确认范围，在独立分支进行小步修改，并运行受影响测试与根质量检查。开发细节见[参与贡献](../developers/contributing)。
