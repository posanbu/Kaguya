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

`memory.writeback` 默认关闭，开启后提供可靠原始写回与稀疏召回。`memory.knowledge`、`memory.index` 和 `memory.cognition` 是独立的工作区模块实例，均依赖原始记忆。概览提供即时开关；模块设置页填写 embedding 和 Mem0 的 `revision`、`baseUrl`、`apiKey` 等参数。密钥写入后不会在读取接口中回显。Profile 不包含 Memory 字段，也不带版本字段。

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
- **Experience / episode — 共同经历。** 现有 Knowledge 契约允许显式关联多个原始事件。自动语义分段、reply 链补全和形成触发规则尚未确定，32 条窗口不能直接视作一段完整经历。
- **Long-term cognition — 长期认识。** 现有 provider 产出 operation 隔离的有界快照，Knowledge 保存显式断言及其修订。如何让经历持续形成可修正、可召回的认识，仍需明确完整证据范围、幂等键和迁移边界。

## ADR：事件、实体与 Wiki 的可回退原型

**状态 — 显式启用的首版原型，对应 #197。** 原始账本继续保存不可变 Information；新增 PostgreSQL 投影保存通用事件、追加式断言、episode 和 Wiki 修订。它们复用 canonical entity atom 的 `informationId`，不创建第二套人物 ID，也不引入隐藏 Session。事件处理关系仍由 Information DAG 表达；主体、说话者和经历关系独立保存。

在 Profile 的 `memory` 对象加入 `knowledgeEnabled: true`，并保持 `enabled: true`，才会创建附加表、激活 `memory.knowledge`、注册实体检索与恢复任务。省略该字段保留原有行为。按现有配置流程保存并显式应用或重启；回退时关闭该字段，保留原始文档和新投影用于审计，不删除数据。默认方案的改变仍需质量与成本评测。

**来源与归属 — 显式、可追溯。** `MemoryKnowledgeAccess.putEvent` 接收来源 ID、范围 ID、事件时间、事件类型、正文、actor 与 subjects；reply-to、媒体片段和动作阶段为可选字段。事件的入库时间由数据库产生。canonical 消息的原文、平台范围及已解析说话者必须与账本一致，匿名 Web 不进入长期投影。通用事件自身需要 `agent:scope` 来源引用，已解析 actor 需要可核验的来源绑定；设备默认使用 `device.entity`，其他范围 kind 由宿主显式允许。`generated`、`completed`、`failed` 等动作阶段分别保存，不能互相替代。

**断言与经历 — 保留视角和演化。** 断言保存主体、陈述者、predicate、value、认识性质、有效区间、入库时间、原始来源以及精确的 supersedes/retracts 关系。不同人的互相矛盾陈述可以并存；修订不会机械覆盖其他人的视角。episode 将多个原始事件关联为一个经历。新消息自动提取的仅是平台昵称和群名片观察，正文不自动转成人物偏好。第三人称转述、玩笑、隐含指代、语义 episode 分段及身份误合并后的正确重绑定仍需后续提取/身份模块与质量验证。

**Wiki — 有界的证据入口。** 每个页面以范围与实体组合寻址，不跨范围拼接。页面有版本、生成器版本、双时间截止点、章节与原始证据。默认生成器使用原文摘录和显式断言，最多 8 条来源预算，最多 16 个章节，单段展示最多 3000 字符；截断会公开标记。重要旧断言的证据先于近期闲聊获得预算，完整原文保留旁路。这里的原始来源存在性校验不等于语义支持验证，页面不提供执行权限。

`readWikiPage` 只提供当前未失效页面；`listWikiRevisions` 按版本分页提供历史审计。开发者控制台的“事件与 Wiki 记忆”显示修订正文、范围、原始 ID、时间和截断状态，历史修订不能被当作当前认识。原文超过 16000 个 UTF-16 code units 时，首版不创建事件投影，原始 Information 及既有 raw Memory 写回继续保留其各自契约。

**恢复与修订 — 持久化工作流。** 模块启动登记回填根，按账本登记顺序每页最多 50 条处理历史身份终态与显式事件；实时订阅不能代替历史回填。数据库记录持久 dirty 状态，刷新冻结页面版本及 dirtyVersion，通过 CAS 拒绝过期更新。revision 的 operationId 覆盖数据库提交后进程中断的重试窗口。启动及可靠 mutation 完成后登记有游标的维护任务，逐页安排脏页恢复；单页刷新失败不会阻塞其他维护页。

其他模块通过 `memory.knowledge.mutation.requested` 可靠追加断言/episode、撤回来源或使实体投影失效，相关证据与范围必须显式引用。实体失效用操作 ID 幂等执行，重试旧修订不会撤回之后新增的证据。永久非法事件以 skipped 终态隔离，瞬时数据库失败继续由 Reliable Runner 有界重试。直接调用仓储是宿主管理接口，调用方需要显式触发维护；在线模块应使用可靠协议。

**规划与生成 — 冻结并重载原始证据。** Heartflow 在规划前使用同范围、双时间截止点和总预算选择记忆；实体导航与当前 Wiki 来源只作为寻找原文的入口。Core 重载原始 Information 后，模块还会再次核验原生范围与事件时间。Mem0、知识导航与 sparse/hybrid 共用有界选择；知识路径关闭或不可用时保留原文基线。页面尚未覆盖的新事件仍可以走原文路径。撤回来源在知识路径开启时同时过滤 raw 召回及包含该来源的认知快照，避免通过另一条检索路径重新引入。

## 首版验证与后续评测

本地确定性回放覆盖多人转述/纠正、同昵称不同人、改昵称、跨范围隔离、双时间截止、迟到事件、显式断言冲突与撤回、通用设备反馈、CAS、数据库提交后重试、历史回填、停用重开和脏页恢复。这些测试验证协议与可靠性，不测量真实模型的回答正确率、群聊参与适当性或人物归属能力。

Mem0 仍是已有 operation 隔离的对照路径，原文 sparse/hybrid 保留；未接入 Hindsight、Zep/Graphiti，也未据公开分数决定更换默认 provider。后续需在实验前固定中文多人对话与设备事件回放、模型及 Prompt 版本、原始证据顺序、上下文/检索预算、评价规则和验收阈值。至少对照原文、Mem0、实体与断言、实体与断言加 Wiki，分别保存原始输出、证据命中、拒答、人物串线、时间更新、成本、延迟及失败样例；离线构建成本独立报告。在取得这些证据前，#197 的 provider 对照、质量收益与默认上线决策仍未完成。
