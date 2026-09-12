# Heartflow

## 目的与非目标

协调在线 Agent 回合的可靠推进；不实现具体注意评分、回复生成或平台发送。

## 消费和产生

消费 candidate、身份终态、注意决策及宿主终态，产生 claim、冻结 context、分派请求和 turn terminal。

## 数据流与边界

使用 scope generation、identity barrier 和 `asOf` Selector 冻结回合。Attention Arousal 的结果只能由本模块分派。

## Settings

配置机器人名称、群聊/直接会话频率、mute 和 stale 界限。

## 可靠性、幂等和失败行为

每个 candidate 只有一个 claim 和 turn terminal；更新 candidate 可 supersede 尚未决策的旧回合。

## 日志与可观测性

记录 context、claim、waiting、silent、completed、failed 和 superseded 生命周期。

## 典型场景

`attend` 临时创建当前会话消息意图，`defer` 请求 Heartbeat，`ignore` 正常静默结束。
