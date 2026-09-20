# 外部 Memory 认知

## 目的与非目标

把提取与冲突消解委托给外部 provider，Kaguya 只负责可靠调用、证据和结果校验。

## 消费和产生

消费 writeback completed 与 cognition requested；产生 cognition completed 和只有完成后才可消费的 core.memory.text。

## 数据流与边界

只由 canonical 且人物明确的身份终态触发，ephemeral/Web 只保存 raw Memory。冻结同 platform、adapter、destination 中最近最多 32 条已持久化消息；群聊保留各参与者，私聊额外要求同一发送账号。provider 通过 `kaguya:memory.cognition@1` 接收正文、各自账号与有序来源；Mem0 输入显式保留陈述者、场景、事件时间和 Information ID，不把所有消息当作同一人的自述。结果保留直接证据引用。

worker 重载时逐项比对账本和持久化原文，校验事件截止点与文档入库时间；读取消费侧再次核对场景和证据截止点。新快照使用 `scene.v2` 范围键，历史单发送者快照保留审计，旧 pending request 仍按原范围恢复。Mem0 operation 命名空间保持隔离。

开启 Knowledge 后，在线选择通过 Core 命名策略检查快照的整个来源集合。任一来源已撤回或因身份修正失效，就拒绝整份快照；策略未注册或仓储检查失败时同样拒绝。关闭 Knowledge 时保持原有认知基线，不调用该检查。该规则保护历史 Mem0 快照，不把部分仍有效的来源当成整份摘要仍然成立的证明。

## Settings

模块使用严格空设置。selected Profile 的 `memory.enabled` 控制全局开关；provider 端点与凭据由 composition 持有，不进入模块 settings。

## 可靠性、幂等和失败行为

request 按 provider 身份与 source 事件去重；同 request 只有一个文本和终态。无效来源拒绝，故障有界重试；停机保留 pending。最新已完成证据快照替代旧快照用于后续 Prompt，旧原子不删除。

## 日志与可观测性

request/terminal 可通过 Information Inspection 查看。普通日志只包含稳定状态，不输出正文、向量、模型密钥或远端原始错误。

## 典型场景

认知服务暂时不可用时，原始消息仍能保存和召回；重新运行后新回合仅使用此前已完成、同范围的快照。
