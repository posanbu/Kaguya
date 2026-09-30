# 可选入站原文索引

## 目的与非目标

开关开启时，将每条身份终态对应的 inbound 写入额外的长期文档与稀疏索引，不读取 assistant、不提取事实、不依赖回复。供 Light/Heavy 使用的原始事件投影由 Runtime 常开维护，与本模块独立。

## 消费和产生

消费 `memory.identity.person.context.completed` 与 `memory.raw.requested`；产生 requested、completed、empty、failed。

## 数据流与边界

通过 `core:status-of` 加载 inbound，request 只保留引用，worker 通过 `memory:access@1` 写库。Web ephemeral 与 canonical 消息均参与。

## Settings

模块使用严格空设置。工作区 `memory.raw` 实例由 `cordis.yml` 的 `disabled` 控制，重启后生效；未完成的 native/mem0 没有 provider 设置。

## 可靠性、幂等和失败行为

以 source Information ID 注册一次；写库成功但终态丢失时通过 MemoryStore 幂等恢复。空白正文提交 empty，非法输入或来源冲突提交 failed，瞬时错误有界重试后 exhausted。

## 日志与可观测性

request/terminal 可通过 Information Inspection 查看。普通日志只包含稳定状态，不输出正文、向量、模型密钥或远端原始错误。

## 典型场景

工作区开启长期记忆索引后，即使没有 Router、Heartbeat 或 Heavy，也可以为入站消息建立额外文档。常开事件背景不受此开关影响。
