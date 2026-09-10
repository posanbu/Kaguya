# Attention Arousal

## 目的与非目标

判断冻结事件是否值得 Agent 注意。它不选择话题、不调用模型、不生成回复，也不执行行动。

## 消费和产生

消费 `agent.turn.context.completed`，产生 `agent.attention.arousal.completed`。

## 数据流与边界

Heartflow 冻结直接性、内容、消息压力、空窗和近期存在感；本模块只对该快照执行硬门禁与确定性评分。`attend` 当前由 Heartflow 临时桥接到回复链。

## Settings

配置触发阈值、延期毫秒数以及策略和设置摘要。默认阈值 80，延期 15 秒。

## 可靠性、幂等和失败行为

使用 claim 的唯一决策终态。相同上下文和设置产生相同结果；硬门禁始终优先。

## 日志与可观测性

完成原子记录 outcome、分数、分量、原因、策略摘要和等待次数。

## 典型场景

私聊或明确指向机器人时 `attend`；普通单条群消息 `defer`；等待预算耗尽后 `ignore`。
