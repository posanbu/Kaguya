---
title: Memory 认知层选型
description: Memory 原始文档、可重建向量与可替换认知层的边界。
---

# Memory 认知层选型

> **历史命名空间边界：** Memory、Identity、Expression 与 Association 已统一使用 `memory.*` 协议命名空间。更早期的 definitionId、Information Kind、可靠操作键、模板和 capability 不提供别名或双读。本次独立开关的配置变更不会删除现有 PostgreSQL 消息、索引或记忆记录；旧命名空间实例仍需单独处理，不应混用。

## 处理单位与当前边界

Memory 需要区分触发单位、原始证据和派生认识。相关 Information 到达可以唤醒后台处理，但触发 handler 的 atom 不自动等于完整经历。模块应按职责选择单条证据、同范围窗口、冻结 context 或其他证据集合，并让派生结果继续引用原始 Information。完整设计原则见[持续 Agent 设计原则](./continuous-agent)。

当前 `memory.writeback` 为每条身份终态保存对应 inbound。这是 raw evidence 的保真、去重和召回边界，逐消息工作本身不是需要修正的问题。Identity、索引与来源核验同样可以合理地逐项推进。

当前 `memory.cognition` 也由每条 canonical writeback 完成触发，但不会只读取触发消息：它冻结同场景最近最多 32 条已持久化文档，再交给 provider 产生有直接来源的快照。因此现状是“逐消息触发、重叠窗口认知”，不是“单消息认知”。这种触发节奏、窗口重叠和长期经历应如何组织仍属于待讨论设计；本页后续内容准确描述已经实现的窗口协议，不把未来方案冒充为现有能力。

## ADR：采用独立 Mem0 REST 服务

**状态 — 已实现。** 对应 #90。原始消息只由 Kaguya 的 PostgreSQL MemoryStore 保存；认知服务不取得 Kaguya 数据库连接、模型密钥或全局账本读取权限。

选择 [Mem0 OSS](https://github.com/mem0ai/mem0) 作为首个可替换 provider，通过其 [REST API](https://github.com/mem0ai/mem0/blob/c7ee362aff94a369af70f13f2b4f853f6793ff4c/server/main.py) 独立部署。2026-09-12 核对的上游 revision 为 `c7ee362aff94a369af70f13f2b4f853f6793ff4c`，[许可证为 Apache-2.0](https://github.com/mem0ai/mem0/blob/c7ee362aff94a369af70f13f2b4f853f6793ff4c/LICENSE)。Kaguya 不复制、vendor 或改写 Mem0/A_Memorix 的演化源码。A_Memorix 的 AGPL 与 Alpha 部署评估不纳入本次默认接入。

**部署 — 独立服务。** Mem0 自行管理其 LLM、embedding、向量和历史后端；只在工作区的认知记忆实例显式启用时调用。服务凭据由宿主持有，模块只能使用版本化 `MemoryCognitionProvider` capability。不得向在线 Prompt 暴露服务地址、密钥或原始异常。

**演化单位 — 有界证据快照。** 每次输入是同一 platform、adapter、destination 内已持久化的有序原始文档窗口。群聊保留不同账号的提问、转述与纠正；私聊还要求同一发送账号。每条输入保留陈述者的平台账号、场景、事件时间和 source Information ID，陈述者不自动等同于被谈论者。provider 独立完成提取与冲突消解；Kaguya 不实现事实合并启发式。每个 operation 继续使用独立上游命名空间，避免服务隐藏历史把未授权来源带入结果。派生快照保留完整的直接 source Information 引用，按证据截止时间选择最新的已完成快照，旧快照仍可审计。

**恢复 — 本地唯一终态。** 网络超时交给 Reliable Runner 有界重试；远端可能已经执行的请求允许重放，本地只接受一个有效快照。上游 REST 不提供跨网络的 exactly-once 事务保证，因此不把远端内部对象当作 canonical Memory。provider 故障不会影响 raw Memory 的写入和稀疏召回。

**边界 — 不建立第二事实源。** 派生结果只在明确选择、重载证据和校验 scope 后进入 Prompt。向量索引单独保存模型、revision、维度；既不执行事实演化，也不改变 canonical 文档。

## 配置和启用

`memory.writeback` 默认关闭，开启后提供可靠原始写回与稀疏召回。`memory.index` 和 `memory.cognition` 是独立的工作区模块实例，均依赖原始记忆。概览提供即时开关；模块设置页填写 embedding 和 Mem0 的 `revision`、`baseUrl`、`apiKey` 等参数。密钥写入后不会在读取接口中回显。Profile 不包含 Memory 字段，也不带版本字段。

Mem0 服务需要支持 `POST /memories` 的 `infer`、`user_id`、`run_id`、`metadata`，以及 `GET /memories` 的同名过滤与 `top_k`。部署与凭据由服务端管理，Kaguya 不启动该服务，也不把自身模型密钥交给它。适配器要求返回的 `user_id` 与 `metadata.sourceInformationIds` 对应本次操作；不符合契约时拒绝结果。每次认知最多读取 32 条同范围已入库消息，返回最多 32 条事实，超时为 30 秒。它保留完整输入窗口作为保守的来源集合，不把集合引用声称为逐句语义验证。

## 原始消息写回

`memory.writeback` durable 消费身份终态，用原始 inbound Information ID 登记唯一 request。Web ephemeral 与 canonical 消息都写入，人物 ID 不作为 Memory 主键。正文仅保存在原始文档，request/terminal 不复制正文。空正文、非法输入与来源冲突有明确终态；数据库瞬时错误由 Reliable Runner 有界重试，stop 保留 pending。

composition 只使用持久化配置中显式启用的写回、索引和认知实例。没有在线 Heartflow、Heartbeat、Composer 也能验收后台闭环。

## 向量与混合召回

向量是可选投影表 `memory_document_vectors`。Runtime 只在显式配置 embedding 时尝试准备 pgvector；扩展不可用时记录稳定状态，原始写回与 sparse recall 保持可用。标准托管 `postgres:17-alpine` 镜像不包含 pgvector；需要向量功能时，应自行准备安装了 pgvector 的 PostgreSQL 17，并通过 external database 配置接入，不替换现有托管卷。

每条向量使用 `memoryId + modelId + revision + dimensions` 唯一键。稀疏和向量分别在同一 namespace/account/scope、截止时间与排除来源约束内取 Top-K，以 RRF 融合，再用 memoryId 稳定排序。在线模块显式传入冻结聊天范围。embedding 失败或维度不符时退化为稀疏结果。

启动时登记最多 50 条一页的历史回填；每页先提交逐文档 request 与 continuation，再提交页终态。模型/revision/维度变更会产生新的回填根，旧任务显式 superseded。重建被删除的派生索引，或在修复 exhausted 任务后重新处理全量历史时，使用新的 revision；不修改原始 MemoryDocument。

## 已完成认知与 Prompt

身份未解析或 ephemeral/Web 消息不触发长期认知。canonical 消息写回完成后，在同场景的最近 32 条消息内冻结已持久化来源；其他参与者按各自的平台账号保留归属，不依据昵称合并人物。认知 request 只携带稳定 provider 身份、有序来源、范围和事件截止时间。worker 从 Memory 重载文档，与账本核对正文、地址和事件时间，并拒绝晚于事件截止点或请求登记时刻才持久化的文档。成功时登记文本和唯一完成终态；文本先提交但终态尚未完成的中间状态不会进入 Prompt。后续 Heartflow 选择同 provider/revision、同场景、截止时间内的完整快照，重新核对直接证据与截止点；私聊同时保留账号边界。原始消息仍独立参与召回。

**回复关系 — 只补充冻结窗口内的证据。** worker 从已核验的入站账本原子读取 `source.replyTo`，补入交给 provider 的临时 cognition document；原始 `MemoryDocument` 和数据库结构不变。可选 `replyTo` 包含平台原生 `platformMessageId`、可选发送者提示 `senderId`，以及 `sourceInformationId: string | null`。只有同一冻结窗口内存在唯一的非自身目标，且平台消息 ID 与可用的发送者提示都匹配，才填入目标 Information ID；目标不在窗口、存在歧义或只有自身匹配时保留外部回复引用，将该 ID 置为 `null`。这表示目标尚未在当前证据中解析，不表示回复不存在。

Mem0 的每条消息同时保留本消息的 `platformMessageId` 和可用的 `replyTo`，因此群聊中的提问、插话与短句回应仍有可核验的关系。输入没有回复关系时可继续省略该字段，旧输入保持兼容。重试始终从 request 冻结的有序来源 ID 重载并校验原文，不为了补齐 reply 链自动扩展窗口；解析到目标也不等于已经证明某条派生事实的语义归属。

群聊窗口使用带 `scene.v2` 标记的范围键。历史单发送者快照继续保留供审计，新的在线选择不把它们当作多人场景快照；尚未完成的旧 request 仍可在原有单账号范围内恢复。新旧请求都保持各自的 operation 命名空间隔离，不把远端历史当作增量人物画像。上述迁移不删除原始 MemoryDocument，也不改变 sparse/hybrid 召回约束。

认知是一个最多 32 条文档的有界窗口，不能作为无限历史画像。每条新的 canonical writeback 都可能形成一份与前一份高度重叠的窗口；这是当前已实现行为，不表示项目已经确定它是长期认知的最终处理单位。外部服务的事实质量与语义证据判断仍需部署方评估；本地自动化测试验证的是协议、来源/范围、失败隔离与恢复，不代替真实服务的质量评测。

## Memory 形成模型的当前边界

[#74 重新打开后的问题](https://github.com/posanbu/Kaguya/issues/74)是长期记忆的基本单元仍以单条消息为中心。补全回复证据让 provider 更准确地看到当前窗口的关系，但尚未完成 episode 存储、稀疏／向量索引、召回排序、Prompt 投影和 Inspection 展示的契约迁移。

以下职责区分用于说明当前实现与后续设计的衔接；[#242](https://github.com/posanbu/Kaguya/issues/242) 的形成模型仍待人工确认，尚未确定最终切分算法或存储结构。

- **Raw evidence — 原始证据。** 不可变 Information 与逐消息 Memory 写回保存原文及来源。逐条保存仍然有效，后续调整派生单元不应删除这条证据路径。
- **Context — 当前情境。** 当前 cognition 使用最多 32 条同范围消息作为有界输入。它表达本次实际可见的证据范围；多个 tick 如何累积为稳定 observation，仍由 [#244](https://github.com/posanbu/Kaguya/issues/244) 设计。
- **Experience / episode — 共同经历。** 当前未实现独立的经历存储。自动语义分段、reply 链补全和形成触发规则尚未确定，32 条窗口不能直接视作一段完整经历。
- **Long-term cognition — 长期认识。** 现有 provider 产出 operation 隔离的有界快照。如何让经历持续形成可修正、可召回的认识，仍需明确完整证据范围、幂等键和迁移边界。
