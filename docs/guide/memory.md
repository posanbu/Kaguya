---
title: 记忆配置
description: 开启历史消息记忆，并按需配置向量检索和认知服务。
---

# 记忆配置

Memory 让已保存的历史消息参与后续回复。默认关闭；初次使用先确认模型和聊天正常，再决定是否开启。

## 开启基础记忆

在配置页启用 **Memory**，保存并应用当前配置。

**`memory.enabled`** — 总开关，默认 `false`。开启后启用原始消息写回和内置文本检索，不需要额外的 embedding 或 Mem0 服务。

关闭后不再读取、写入或召回实际 Memory，已有数据不会因此删除。网页对话记录与 Memory 是不同用途的功能，关闭记忆不等于删除聊天记录。

记忆只会在对应的会话范围内按需取用，不保证每一条历史消息都出现在回答中。

## 可选：向量检索

需要按语义检索时，可以在 Profile JSON 的 `memory.embedding` 中配置模型服务。网页目前只编辑总开关，高级字段请先停服、备份，再修改文件并重启。

**`providerId`** — 本地使用的供应商标识。

**`modelId`** — 服务实际提供的 embedding 模型 ID。

**`revision`** — 这套索引的版本标识。更换模型或需要重新处理历史时使用新值。

**`dimensions`** — 模型输出维度，范围 `1–16000`，必须与实际输出一致。

**`baseUrl` / `apiKey`** — embedding 服务地址与密钥。

向量功能还需要安装了 pgvector 的 PostgreSQL 17。默认托管镜像不含此扩展；需准备外部数据库，按[运行参数](./runtime)接入。向量不可用时仍可使用基础文本检索。

## 可选：认知服务

`memory.cognition` 可连接独立部署的 Mem0 REST 服务，用于从有界的历史消息窗口提取事实。

**`provider`** — 固定为 `mem0-rest`。

**`revision`** — 认知配置的版本标识。

**`baseUrl` / `apiKey`** — Mem0 服务地址与凭据。Kaguya 不会自动部署或启动 Mem0，它的模型和数据库也要另外配置。

启用认知并不等于拥有无限历史的人物画像。身份未解析的消息和 Web 临时身份消息不触发长期认知，基础消息记忆仍独立工作。可复制的配置片段和服务契约见[Memory 开发参考](../developers/memory#配置和启用)。

## 可选：事件与 Wiki 原型

**`memory.knowledgeEnabled`** — 默认不启用。与 `memory.enabled: true` 一起使用时，开启事件、实体与 Wiki 的首版原型。关闭后保留已有数据。

此项仍需要效果与成本验证，普通聊天无需开启。实现边界见[事件与 Wiki 说明](../developers/memory#adr-事件、实体与-wiki-的可回退原型)。
