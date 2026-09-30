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

## 常开的原始事件投影

Runtime 的 `PostgresRawEventStore` 按 `information_lifecycle.position` 推进持久检查点。它把入选事件的 Kind、原载荷、引用、结构化 scope、发生时间和注册位置写入 `memory_raw_events`；包装必需的关联原子也按 Information ID 复制。`filter.decision` 的拒绝关系单独记录，用于排除入站消息。历史账本在首次冻结前回填，重启后从检查点续跑。投影与检查点同事务提交，重复执行不会产生重复事件。

Router 冻结前等待投影越过该轮 context 原子的注册位置。投影失败时该 durable 订阅持续重试、报告错误，本轮保持待处理；Light/Heavy 不会在屏障前运行。冻结结果写为 `agent.router.memory.context.frozen`，含两块文本、来源 ID 和预算状态。Light 与 Heavy 引用同一个事实，既有 Model Task 重放沿已持久化 Prompt 读取。

包装器仅处理首版九个语义 Kind：入站文本、投递成功与失败、会话范围绑定、平台账号绑定、人物画像修订、派生记忆文本、成功的表达习惯学习、人物事实提取。每个 Kind 独立验证证据并输出可读状态；没有通用 JSON 回退。请求、草稿、模型任务和调度事件只会作为必要证据保存，不直接进入背景。

全面背景读取冻结时间前十分钟的全部 scope；当前块读取本 scope 十分钟、窗口前最近三十条历史语义事件和全部未读原文。两块目标总预算为 32,000 字，超出时缩短近期窗口；三十条保底和未读原文保留，超限标记在冻结事实中。

## 可选原文索引

`memory.raw` durable 消费身份终态，沿引用读取对应原始 inbound，并以来源 Information ID 幂等保存到 `memory_documents`。文档写入时建立 Unicode 稀疏索引；开启开关会补建既有文档的索引。该开关不控制常开的 `memory_raw_events` 投影，也不改变当前两块背景的读取。

Memory 的工作区即时开关仅包含 `memory.raw`。Profile 的 Memory 组合配置只有 `enabled`；没有 embedding 或 Mem0 提供方设置。
