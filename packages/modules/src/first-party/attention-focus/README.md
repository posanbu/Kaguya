# 持续关注

## 目的与非目标

Focus 是按会话范围持久化的有限期租约，用于让直接唤醒后的群聊保持可观察。它不代表必回复，不改变 Planner 协议，也不绕过安全或出站检查。

## 消费和产生

Heartflow 在直接通知已 observe 后产生 `agent.attention.focus.opened`；本模块消费 opened、renewed、成功投递、silent、failed 和 Scheduler due，输出 renewed、closed 或 expired。

## 数据流与边界

Arousal 在读取正文前通过只读 Selector 冻结当时有效的租约。成功投递续租，silent 或 failed 关闭，wait 保持至自然到期；私聊不创建租约。

## Settings

本模块没有独立设置。租约时长由 Heartflow 的 `focusIdleMs` 管理，默认 120000 毫秒。

## 可靠性、幂等和失败行为

每个 grant 使用独立 generation 和 durable 到期调度。开启、续租和终态使用稳定来源去重；关闭或到期只影响对应代际，旧代际到期不能关闭新租约，重启后可由账本和 Scheduler 恢复。

## 日志与可观测性

Inspection 通过 caused-by、uses-context 和 status-of 展示租约生命周期、来源、状态和到期时间。普通日志不记录正文。

## 典型场景

群聊 @机器人并成功 observe 后开启租约；后续普通通知在租约有效时唤醒观察。成功发言续租，Planner wait 保持原租约，silent、failed 或自然到期结束关注。
