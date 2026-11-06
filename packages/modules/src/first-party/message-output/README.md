# 文字输出模块

## 目的与非目标

本模块是已授权正文的默认输出处理器。它不生成正文，不调用平台，也不选择 TTS provider。

## 消费和产生

模块消费 `core.message.assistant.authorized`，产生文字类型的 `core.delivery.requested`。

## 数据流与边界

Heavy 完成目标授权后登记稳定的授权输出。本模块保留原始 assistant 因果来源和回合引用。Runtime 继续负责白名单、目标时效校验和平台发送。

## Settings

本模块没有 Settings。Composition 仅在当前激活集合没有提供 `agent:message-output-processor` 时自动加入它。外部 TTS 插件提供同一 capability 后，本模块不会激活。

## 可靠性、幂等和失败行为

模块按授权输出 ID 使用稳定幂等键。同一正文只产生一个文字投递请求。两个输出处理器同时启用会因 capability 冲突而拒绝启动。

## 日志与可观测性

授权输出是内部机械节点。文字投递请求沿用 `delivery.requested` 日志和 Runtime 投递终态。

## 典型场景

默认配置保持原有文字回复。启用独立 TTS 输出插件后，插件接管授权输出并选择语音或文字回退。
