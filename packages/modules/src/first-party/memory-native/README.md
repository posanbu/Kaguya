# 统一记忆

## 目的与非目标

`memory.native` 形成、整理和检索人物、会话、自身、经历与表达记忆。身份绑定仍由身份模块负责，QQ 下载和投递仍由平台插件负责。

## 消费和产生

消费身份就绪、成功投递、定时到期、QQ 语义观察及版本发布事件。产生 `memory.native.formation.requested.v1`、`memory.native.formation.completed.v1` 与 `memory.native.revision.v1`。

## 数据流与边界

`collection.ts` 解析来源引用。`facts.ts` 定义事件与模型输出。`formation.ts` 校验形成与整理提案。`index.ts` 编排持久化队列与异步索引。`prompt.ts` 为 Light 和普通 Heavy 请求追加同一回合的冻结记忆。领域端口和检索策略在 `packages/memory`，事务与索引在 `packages/database`。

## Settings

统一开关控制整个模块。语义与语言 embedding 分别设置提供方、模型、版本、维度和超时，默认关闭。配置沿用保存、应用和重启机制。

## 可靠性、幂等和失败行为

来源按作用域积累 8 条或等待 60 秒触发，每批最多 24 条。持久化批次和操作 ID 支持重试。发布校验预期版本、来源与手动锁。图、文本索引和修订账本在同一事务提交。向量索引失败只降低辅助召回能力。固定读取失败终止该次上下文装配。

## 日志与可观测性

检查页显示形成结果、发布记录和两类索引状态。情境页读取持久化的请求快照。召回记录保留渠道、图路径和截断信息。

## 典型场景

没有关键词时，适用人物摘要仍作为 level 0 固定注入。群聊属性、自我认识和表达习惯共用固定条目。具体经历通过文本、图和可选向量召回。成功投递仅证明消息已经发出，不证明消息内承诺的行动已经完成。

完整契约见 `docs/developers/memory.md`。

## 经历操作契约

新请求在 `memory.native.formation.requested.v1` 中持久保存 `formationPolicy: "experience-operations.v1"`。旧请求没有该字段，继续使用其冻结时的输出 schema。来源按 registration position 收集，因此发生时间较早但迟到的更正也能进入后续批次。批次大小不决定经历边界。

形成器用已有节点 ID 作为 `key` 增补同一经历。新节点使用批次 ID 与 key 派生稳定 ID。输出可附带一次 `experienceOperation`：

| 操作                    | inputIds          | outputIds        | 节点要求                                                        |
| ----------------------- | ----------------- | ---------------- | --------------------------------------------------------------- |
| correct / seal / reopen | 一个已有 ID       | 同一个已有 ID    | 发布下一 revision；seal 为 sealed，reopen 为 open               |
| merge                   | 两个或更多已有 ID | 一个新 key       | 输入归档，输出 active，来源覆盖所有输入的证据                   |
| split                   | 一个已有 ID       | 两个或更多新 key | 输入归档，输出 active，各输出明确分配来源，合计覆盖全部输入证据 |

服务端从冻结快照生成 expectedVersions，从存储证明派生来源归属和 predecessors。自动合并／拆分也必须经过当前有效性、人工锁、来源失效和预期版本检查。归档输入不能再次分叉，已有节点不能被冒充为新输出。原始提案以 batchId 作为 operationId 发布；重复执行返回同一结果，冲突触发持久后继批次重新冻结。

空结果和无变化只确认读取范围。失败保留已发布版本及待处理来源。查询通过 `NativeMemoryAccess.freeze/recall/prepare` 携带作用域、所有者、时间与 publication cutoff；历史分页、原生工具的读写授权由 database/runtime 的现有端口负责。形成器不另建记忆存储或前台 writer。
