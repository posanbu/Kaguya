---
title: 记忆配置
description: 原始消息写回以及尚未完成的记忆模块。
---

# 记忆配置

Kaguya 的 Memory 目录包含五个模块：`memory.identity`、`memory.expression`、`memory.raw`、`memory.native` 和 `memory.mem0`。

## 原始消息写回

在“概览”开启 **原始记忆**，即启用 `memory.raw`。它在身份处理结束后保存入站原文，聊天回合即使没有回复也会写回。开关默认关闭，保存后重启生效。关闭开关不会删除已经保存的原始文档。

`memory.identity` 负责会话和人物身份，`memory.expression` 负责表达习惯。它们仍按各自模块配置运行。

## 尚未完成的模块

`memory.native` 计划统一自研的联想与索引，见 [跟踪 Issue #265](https://github.com/posanbu/Kaguya/issues/265)。`memory.mem0` 计划承载 Mem0 认知记忆，见 [跟踪 Issue #266](https://github.com/posanbu/Kaguya/issues/266)。模块目录显示“未完成”和 Issue 链接；这两个模块没有实例、启用开关、检索、订阅或后台任务。

当前聊天可以读取本轮输入和正常聊天历史，但不会从原始记忆库额外召回消息。原始消息写回与聊天流程相互独立。
