---
title: Memory 模块边界
description: 当前五个 Memory 模块的职责与未完成状态。
---

# Memory 模块边界

当前模块目录有五个 Memory 定义：

| 模块                | 当前状态                                                           | 职责                                     |
| ------------------- | ------------------------------------------------------------------ | ---------------------------------------- |
| `memory.identity`   | 运行                                                               | 解析会话、账号与人物身份。               |
| `memory.expression` | 运行                                                               | 学习与选择表达习惯。                     |
| `memory.raw`        | 可启用                                                             | 按入站 Information ID 可靠写回原始消息。 |
| `memory.native`     | [未完成，Issue #265](https://github.com/posanbu/Kaguya/issues/265) | 规划联想与索引的一体化自研记忆。         |
| `memory.mem0`       | [未完成，Issue #266](https://github.com/posanbu/Kaguya/issues/266) | 规划基于 Mem0 的认知记忆。               |

`native` 和 `mem0` 只有目录定义。配置默认值不生成它们的实例，模块宿主拒绝激活，设置 API 不暴露启用入口。两者没有订阅、后台任务或检索入口。原 `association`、`index`、`cognition` 的在线运行接线已经移除；Router 不再直接调用原始记忆检索，Heavy 也不再等待联想终态。

## 原始写回

`memory.raw` durable 消费身份终态，沿引用读取对应原始 inbound，并以来源 Information ID 幂等保存到 `memory_documents`。请求和终态不复制正文；空内容、永久输入错误与暂时存储错误仍由可靠执行链区分。它不建立稀疏或向量索引，也不向聊天 Prompt 提供召回结果。

Memory 的工作区即时开关仅包含 `memory.raw`。Profile 的 Memory 组合配置只有 `enabled`；没有 embedding 或 Mem0 提供方设置。历史数据如何供未来模块使用，分别在两个跟踪 Issue 中讨论。
