---
title: 信息账本
description: InformationAtom、Kind Registry、PostgreSQL Ledger 与日志投影的当前实现边界。
---

# 信息账本

信息账本是 Runtime 的追加式数据核心。`apps/server` 的 composition root 显式装配 PostgreSQL/PGlite database、InformationCore、ModuleHost、Model Task 与 transport；消息、Prompt provenance、模型任务和投递结果都通过 Information DAG 表达。

## 信息原子

InformationAtom 是不可变 JSON 快照，包含 `informationId`、`kind`、`occurredAt`、`source`、`payload` 和显式 `references`。状态变化通过追加新原子表达，不更新或删除旧原子。

引用只依赖目标 `informationId`，并用 relation 说明关系。系统不会从用户、群聊或会话字段隐式推断上下文；关系必须由生产该信息的模块明确写出。

## Kind Registry

每个 Kind Definition 声明 payload schema、允许的引用关系和日志策略。Core 内建 Kind 使用保留的 `core.*` 命名；业务 Kind 不能占用该前缀。

InformationCore 启动时 seal Registry，并把完整 Kind 集合同步到存储。数据库中已有 Kind 集合与当前定义不一致时会失败，避免不同进程用不一致 schema 解释同一批事实。

## 追加与读取

InformationLedger 是异步端口，只暴露受控操作：

**`append`** — 原子追加，并在同一事务中校验引用规则与目标 Kind。

**`get` / `getMany`** — 按显式 informationId 读取。

**`query`** — 查询哪些原子通过指定 relation 引用了某个 informationId。

没有 update、delete、TTL 或 compaction。重复 informationId、缺失目标、未声明 relation、违反单值规则或目标 Kind 不匹配都会被拒绝。

## PostgreSQL 与 PGlite

`packages/database` 提供 PostgreSQL 协议的追加式实现和迁移；测试可以使用 PGlite 验证相同语义。原子、引用、Kind 集合与日志 outbox 在事务中维护，数据库触发器阻止事实表被修改。

这不是 SQLite 账本实现。生产使用 PostgreSQL，测试可使用兼容的 PGlite 基础设施。

## 日志投影为什么用 outbox

```mermaid
flowchart LR
  A[追加 InformationAtom] --> B[(PostgreSQL 事务)]
  B --> C[原子与引用提交]
  B --> D[写入 log outbox]
  D --> E[提交后 Projection Runner]
  E --> F[单向日志 Sink]
  E -- 失败 --> G[保留 pending 并增加尝试次数]
```

日志是事实的投影，不是事实来源。需要日志的 Kind 在追加事务中写 outbox；事务提交后，Runner 才把原子交给单向 sink。sink 不能通过该路径再追加原子，因此日志失败不会递归产生新日志事实。

投影失败不会回滚已经提交的原子。任务保留为 pending，记录稳定错误类型，并在以后调用或进程重启后再次处理。

日志投影默认显示主链，debug 展开内部节点与完整 Prompt；具体字段和安全边界见 [Runtime 与 Information 可观测性](./observability)。
