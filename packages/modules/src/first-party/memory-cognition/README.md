# 外部 Memory 认知

## 目的与非目标

把提取与冲突消解委托给外部 provider，Kaguya 只负责可靠调用、证据和结果校验。

## 消费和产生

消费 writeback completed 与 cognition requested；产生 cognition completed 和只有完成后才可消费的 core.memory.text。

## 数据流与边界

只处理 canonical 且人物明确的身份终态，ephemeral/Web 只保存 raw Memory。冻结同 namespace/account/scope 中最多 32 条已持久化文档。provider 通过 `kaguya:memory.cognition@1` 接收正文与有序来源；结果保留直接证据引用。

## Settings

模块使用严格空设置。selected Profile 的 `memory.enabled` 控制全局开关；provider 端点与凭据由 composition 持有，不进入模块 settings。

## 可靠性、幂等和失败行为

request 按 provider 身份与 source 事件去重；同 request 只有一个文本和终态。无效来源拒绝，故障有界重试；停机保留 pending。最新已完成证据快照替代旧快照用于后续 Prompt，旧原子不删除。

## 日志与可观测性

request/terminal 可通过 Information Inspection 查看。普通日志只包含稳定状态，不输出正文、向量、模型密钥或远端原始错误。

## 典型场景

认知服务暂时不可用时，原始消息仍能保存和召回；重新运行后新回合仅使用此前已完成、同范围的快照。
