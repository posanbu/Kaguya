---
title: Memory 模块边界
description: 常开原始事件投影、可选索引和 Memory 模块边界。
---

# Memory 模块边界

当前模块目录有五个 Memory 定义：

**`memory.identity`** — 解析会话、账号与人物身份。

**`memory.expression`** — 学习与选择表达习惯。

**`memory.raw`** — 可选的入站原文文档及稀疏索引，供长期召回能力使用。

**`memory.native`** — [未完成，Issue #265](https://github.com/posanbu/Kaguya/issues/265)。

**`memory.mem0`** — [未完成，Issue #266](https://github.com/posanbu/Kaguya/issues/266)。

`native` 和 `mem0` 只有目录定义。配置默认值不生成它们的实例，模块宿主拒绝激活，设置 API 不暴露启用入口。两者没有订阅、后台任务或检索入口。原 `association`、`index`、`cognition` 的在线运行接线已经移除；Router 不再直接调用原始记忆检索，Heavy 也不再等待联想终态。

## 节点与关联存储

`KaguyaDatabase.memoryGraph` 提供新的 PostgreSQL 存储接口。`memory_nodes` 只有三列：

**`id` —** UUID 主键。`putNode` 省略 ID 时生成新节点；指定 ID 时完整替换该节点的 metadata 和正文。

**`metadata` —** JSONB 字典。`occurredAt` 表示记忆内容的出现时间，输入需带时区，保存为 UTC ISO 时间。`tags` 是字符串数组，例如 `['xxx用户', '音乐']`，省略时保存为空数组。其他字段可以保存任意 JSON 值，例如来源、主题或证据。

**`content` —** 字符串或 Markdown 正文。存储保留原始缩进和换行。

`memory_edges` 用 `source_id`、`target_id` 和 `relation` 表示有方向、带关系类型的边，另有 JSONB `metadata` 字典。普通关联的类型默认是 `related`。同一方向的节点对可以有多种关系；同一节点对、同一关系重复写入时更新边的 metadata。外键保证两端节点存在，删除节点会同时删除其入边和出边。

`updateNode` 只更新存在的节点，节点已删除时返回空结果。HTTP 编辑使用该原子更新，避免旧表单在并发删除后重新创建节点。

`listNodes` 支持同时匹配全部标签、出现时间下界（包含）和上界（不包含），并按 ID 升序分页。`listEdges` 支持入边、出边、双向查看和关系类型筛选。两种查询默认返回 50 条，最多 100 条。metadata 使用 GIN 索引，出现时间与目标节点另有索引。

启动时会为现有数据库补建这两张表。节点独立存储，不要求绑定原始消息或 Information 原子。该接口可直接读写节点与边；`memory.native` 的自动提取、后台处理和对话召回仍待实现。

WebUI 的 `/memory` 提供图检视和手动管理。画布复用 react-force-graph 官方高亮示例，以 Obsidian 风格的小圆点和细线呈现，来源与许可记录在 `apps/web/THIRD_PARTY_NOTICES.md`。浏览器和服务端共用 `packages/schema/src/memory-graph.ts` 的协议；浏览器不会导入数据库包。

管理 HTTP 接口统一位于 `/api/v1/memory`，全部复用 Gateway management 认证。`GET /graph` 接受 `search`、重复的 `tags`、`occurredFrom`、`occurredBefore`、`afterId`、`limit` 和 `focusId`。`readGraph` 用一条 SQL 同时读取节点及其内部边，最多 100 个节点、1000 条边，并返回截取标记。`focusId` 将范围限制为中心节点与一跳邻居，中心节点优先返回。

`POST /nodes` 新增节点，`GET /nodes/:id` 检视，`PUT /nodes/:id` 替换正文和 metadata，`DELETE /nodes/:id` 删除节点及其边。`POST /edges` 写入有向类型边，`DELETE /edges` 按正文中的 `sourceId`、`targetId` 和 `relation` 删除一条边。接口返回 `data` 包装；输入错误为 400，节点不存在为 404，关系端点不存在为 409，数据库未挂载为 503。

## 常开的原始事件投影

Runtime 的 `PostgresRawEventStore` 按 `information_lifecycle.position` 推进持久检查点。它把入选事件的 Kind、原载荷、引用、结构化 scope、发生时间和注册位置写入 `memory_raw_events`；包装必需的关联原子也按 Information ID 复制。`filter.decision` 的拒绝关系单独记录，用于排除入站消息。历史账本在首次冻结前回填，重启后从检查点续跑。投影与检查点同事务提交，重复执行不会产生重复事件。

Router 冻结前等待投影越过该轮 context 原子的注册位置。投影失败时该 durable 订阅持续重试、报告错误，本轮保持待处理；Light/Heavy 不会在屏障前运行。冻结结果写为 `agent.router.memory.context.frozen`，含两块文本、来源 ID 和预算状态。Light 与 Heavy 引用同一个事实，既有 Model Task 重放沿已持久化 Prompt 读取。

包装器仅处理首版九个语义 Kind：入站文本、投递成功与失败、会话范围绑定、平台账号绑定、人物画像修订、派生记忆文本、成功的表达习惯学习、人物事实提取。每个 Kind 独立验证证据并输出可读状态；没有通用 JSON 回退。请求、草稿、模型任务和调度事件只会作为必要证据保存，不直接进入背景。

全面背景读取冻结时间前十分钟的全部 scope；当前块读取本 scope 十分钟、窗口前最近三十条历史语义事件和全部未读原文。两块目标总预算为 32,000 字，超出时缩短近期窗口；三十条保底和未读原文保留，超限标记在冻结事实中。

## 可选原文索引

`memory.raw` durable 消费身份终态，沿引用读取对应原始 inbound，并以来源 Information ID 幂等保存到 `memory_documents`。文档写入时建立 Unicode 稀疏索引；开启开关会补建既有文档的索引。该开关不控制常开的 `memory_raw_events` 投影，也不改变当前两块背景的读取。

Memory 的工作区即时开关仅包含 `memory.raw`。Profile 的 Memory 组合配置只有 `enabled`；没有 embedding 或 Mem0 提供方设置。
