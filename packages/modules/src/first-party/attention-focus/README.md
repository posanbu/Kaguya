# 持续关注

## 目的与非目标

让被直接唤醒的群聊在有限空闲期限内延续相关性。租约不代表必回复，也不改变 Planner 协议。

## 消费和产生

Heartflow 产生 `agent.attention.focus.opened`；本模块消费 opened、renewed、回合成功/静默/失败和 Scheduler due，输出 renewed、closed、expired。

## 数据流与边界

Heartflow 在冻结上下文前按直接输入幂等开启，并冻结 focusActive、focusInformationId、focusExpiresAt。Attention Arousal 消费投影，硬门禁优先。后台模块只对成功投递回合续租；私聊不创建租约。

## Settings

Heartflow 的 focusIdleMs 默认为 120000 毫秒；Attention Arousal 的 focusRelevance 默认为 80。本模块没有额外设置。

## 可靠性、幂等和失败行为

每次开启以真实入站 ID 去重，续租以成功回合 ID 去重，generation 指向该来源。每个 grant 的调度键唯一，关闭和到期竞争同一终态槽。旧 grant 到期不影响新 grant。silent、failed 关闭当前回合使用的代际，wait 保留到期。账本投影与 durable 订阅、Scheduler open arms 支持重启恢复。

## 日志与可观测性

Inspection 通过 caused-by、uses-context、status-of 展示生命周期与来源。普通日志只投影范围、原因、到期时间，不记录正文。

## 典型场景

群聊提到辉夜后开启租约；后续普通输入冻结有效关注，在安全与频率允许时提高注意力得分。成功投递续租，空闲到期后普通输入恢复原评分。
