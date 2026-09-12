# 原始消息写回

## 目的与非目标

将每条身份终态对应的 inbound 写入独立 Memory，不读取 assistant、不提取事实、不依赖回复。

## 消费和产生

消费 `agent.person.context.completed` 与 `agent.memory.writeback.requested`；产生 requested、completed、empty、failed。

## 数据流与边界

通过 `core:status-of` 加载 inbound，request 只保留引用，worker 通过 `kaguya:memory@1` 写库。Web ephemeral 与 canonical 消息均参与。

## Settings

模块使用严格空设置。selected Profile 的 `memory.enabled` 控制全局开关；provider 端点与凭据由 composition 持有，不进入模块 settings。

## 可靠性、幂等和失败行为

以 source Information ID 注册一次；写库成功但终态丢失时通过 MemoryStore 幂等恢复。空白正文提交 empty，非法输入或来源冲突提交 failed，瞬时错误有界重试后 exhausted。

## 日志与可观测性

request/terminal 可通过 Information Inspection 查看。普通日志只包含稳定状态，不输出正文、向量、模型密钥或远端原始错误。

## 典型场景

Profile 开启 Memory 后，即使没有 Heartflow、Heartbeat 或 Composer，也可以保存消息。
