---
title: 记忆配置
description: 常开的原始事件记忆、可选长期索引和记忆模块。
---

# 记忆配置

Kaguya 的 Memory 目录包含五个模块：`memory.identity`、`memory.expression`、`memory.raw`、`memory.native` 和 `memory.mem0`。

## 原始事件记忆与开关

运行时始终把入选的原始事件及其证据写入 Memory。Light 与 Heavy 在同一轮读取同一份冻结的“全面背景”和“当前 scope 上下文”；当前块标出尚未观察的入站消息。背景包含最近的各会话事件，因此模型可能看到其他会话的事实；最终发送仍受目标授权检查。

“概览”的 **长期记忆索引** 开关控制额外的入站原文文档、稀疏索引与长期召回能力。开关默认关闭，保存后重启生效。关闭不会删除已有文档或始终写入的原始事件，也不影响上述两块近期背景。开启时会为既有文档补建稀疏索引。

`memory.identity` 负责会话和人物身份，`memory.expression` 负责表达习惯。它们仍按各自模块配置运行。

## 尚未完成的模块

`memory.native` 计划统一自研的联想与索引，见 [跟踪 Issue #265](https://github.com/posanbu/Kaguya/issues/265)。`memory.mem0` 计划承载 Mem0 认知记忆，见 [跟踪 Issue #266](https://github.com/posanbu/Kaguya/issues/266)。模块目录显示“未完成”和 Issue 链接；这两个模块没有实例、启用开关、检索、订阅或后台任务。

当前聊天的两块事件背景来自原始 Memory；独立的可选记忆与人物身份仍按原有流程装配。`memory.native` 和 `memory.mem0` 尚未提供额外认知召回。
