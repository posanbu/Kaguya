---
title: Memory 模块边界
description: 统一领域接口、版本化记忆图、固定上下文与混合召回。
---

# Memory 模块边界

`memory.native` 是统一运行模块。领域契约位于 `packages/memory`，PostgreSQL 实现位于 `packages/database`。composition 注入模型提供方，runtime 注入存储能力。模块不直接查询其他模块的私有存储。

身份模块保留账号、会话和人物绑定。关系、经历和表达使用统一图。QQ 插件保存素材、收集文字上下文、提供用法推断并执行发送限额。推断作为带来源的观察进入 Memory，候选语义从 Memory 读取。旧 Raw 文档、表达学习和 Mem0 模块及其契约、存储接口、模板和查询页面已删除。配置采用不兼容切换，不做自动转换。

<a id="节点与关联存储"></a>

## 图与发布契约

`memory_nodes` 继续只有 `id`、`metadata` 和 `content` 三列。新节点使用 `metadata.system = native-v1`。metadata 记录 `kind`、`ownerId`、`scope`、`level`、`revision`、`status`、`locked`、`sourceIds`、`aliases`、`occurredAt` 和 `tags`。

同一 `ownerId` 和 `scope` 最多有一个有效 level 0，由 PostgreSQL 部分唯一索引保证。节点 ID 不随 level 变化。`summarizes` 要求起点 level 小于终点 level，普通语义连结没有层级含义。

`publish` 接收操作 ID、修改者、预期版本、完整节点和连结变更。在同一事务中更新图、全文索引和 `memory.native.revision.v1` 账本记录。相同操作可重放，内容不一致的重用被拒绝。通用图写接口不能修改托管节点或相关连结。

自动发布要求真实来源，禁止覆盖手动锁定的正文。细节修订后，未同步更新的祖先摘要失效。历史版本保存在追加式账本及发布记录中。向量是可重建投影，不是权威事实库。

管理端通过 `POST /api/v1/memory/publications` 发布。`GET /api/v1/memory/nodes/:id/history` 返回修订，`GET /api/v1/memory/status` 返回处理状态。图查询支持类型、对象、level、状态和旧有正文／标签／时间筛选。表达视图区分习惯、文本示例和 QQ 资源，分类与 level 独立。关系编辑也必须提交两端的预期版本。

## 固定读取与回合快照

固定读取只检查对象、作用域、有效状态和时间，不使用查询词、相似度、排名或数量限额。本轮全局背景和当前会话背景中的所有人物、当前会话、自身及表达对象构成读取范围。人物包括历史发言者、明确提及及回复对象，以及背景内身份绑定记录中的人物。选择器按冻结 Raw 的来源 ID 读取证据，按平台和适配器分别解析明确账号绑定，不按昵称绑定。每个人的适用 level 0 都进入固定快照，即使本轮没有发言。跨会话内容仍受当前作用域与共享范围约束。

稳定人物称呼、自身与人物的关系、自我认识和自身表达可以使用 `shared`。经历、第三方信息和资源默认限制在来源 scope。远程辅助候选先在共享期限内返回，不占用图读取事务。随后在 PostgreSQL 一致性快照中读取固定条目和图候选，并核验辅助候选的节点版本。

固定与动态内容保存在 `SituationFrame.memory`。Light 在参与判断前读取。普通 Heavy 回复复用该回合的版本。Prompt 编译器强制追加 `native_memory` 数据区块，用户模板省略变量也不会漏掉固定摘要。授权跨会话发送保持独立的已批准正文路径，不转发原会话的记忆。

动态正文默认 4000 个 Unicode 字符，附加表达最多 3 条、合计 1000 字符。固定摘要不占这些额度。最终 Prompt 的装配上限为 128000 UTF-8 字节，超限时先移除动态召回，再移除可选的全局近期背景。仍超限时明确失败，固定摘要不能静默遗漏。实际发送的变量与最终文本一起保存。

情境 FAB 按所选请求展示固定条目，召回区展示动态内容。旧请求没有该字段时显示“未记录”，不能用当前图补写历史。

## 检索与索引

检索先执行统一的作用域、状态和时间过滤，再组合实体图候选、显式引用、全文、字符片段及可选的两类向量候选。全文使用 `tsvector`、GIN 和 `ts_rank_cd`。规范化使用 NFKC，中文使用重叠二元片段和短词单字路径。模糊匹配对有界候选计算编辑距离。

各路候选默认最多 50 条。显式引用先保留，其余用 RRF 融合，常数为 60。相同配置的向量检索不重复投票。level 不参与分数。RRF 分数不表示事实置信度。

普通关系展开一跳，摘要关系最多展开四轮，合计最多 100 个节点。每个中间节点都检查作用域。图与 link 是语义联系的权威来源，向量命中不会创建连结或合并身份。

语义和字面向量分别配置。pgvector 投影绑定用途、模型身份、节点版本和输入哈希。后台每轮最多补建 50 个节点，启动、版本发布和周期检查推动重建。检索不等待索引构建。辅助查询共享默认 2 秒期限，失败记录渠道降级，图和文本仍可用。更换模型后只使用新身份的向量。

以上采用分阶段候选与排序设计，参考 [Vespa phased ranking](https://docs.vespa.ai/en/ranking/phased-ranking.html) 和 [OpenSearch RRF](https://docs.opensearch.org/latest/vector-search/ai-search/hybrid-search/rrf/)。这些设计依据不代表本项目已经获得相同的检索效果。

## 运行边界

形成批次默认 8 条或 60 秒触发，最多 24 条来源。批次、模型请求和发布操作分别持久化。失败批次可在检查页重新排队，原失败记录保留，新批次产生新的模型请求。来源按会话串行认领，重启可以继续处理。成功的空结果记录完成，但不创建虚假经历。

新 epoch 保存原始账本位置。旧领域数据不迁移，旧派生内容不进入在线 Raw 背景。记忆开关仅控制 `memory.native`。原始事件投影和普通回复不依赖该开关。

```mermaid
flowchart LR
  Identity[身份绑定] -->|确定主体| Formation[形成与整理]
  Raw[原始证据] -->|提供来源| Formation
  Formation -->|原子发布| Graph[记忆图与版本]
  Graph -->|读取 level 0| Fixed[固定上下文]
  Graph -->|混合检索与沿 link 展开| Recall[动态召回]
  Fixed -->|冻结| Snapshot[回合快照]
  Recall -->|冻结| Snapshot
  Snapshot -->|提供背景| Models[Light 与 Heavy]
  Snapshot -->|展示实际输入| UI[情境]
```

从身份绑定和原始证据开始，固定读取与动态召回分别进入同一回合快照。

## 人物来源与请求投影

`MemorySource` 区分 `inbound` 和 `delivered`。`participants` 保存明确账号绑定的 `ownerId`、发言／提及／回复角色、昵称和群名片。参与者观察沿用该来源的 ID、作用域和发生时间。未解析或绑定冲突的对象保留 `null`。`replyTo` 保存原生回复引用，没有被引用正文时不能推断其内容。

形成请求永久使用 `memory.native.formation.requested.v1`，持久订阅固定为实例 ID 加 `memory.native.form`。字段调整直接更新现行契约，不增加 v2 事件、订阅或兼容读取分支。整理读取本批相关人物的已有版本。姓名和语义相似不能创建身份绑定。自身成功投递的消息只证明说过这些话，不能独立证明对方的身份和关系。

`bootstrap` 使用版本 2，仅保存人物及会话的建档来源、记录时间，以及是否由本轮输入创建。它不输出认识程度。`context_bootstrap` 在最终装配时更新 `fixedMemoryCount`、`recalledMemoryCount` 和 `memoryStatus`。`sourceReferenceCount` 单独统计显式引用的原始消息。动态记忆因预算移除后，同步更新计数和人物节点引用。

冻结的账号与人物映射随记忆快照保存。`conversation.background.participants.ownerId` 将人物卡片连接到同一请求的固定摘要。跨会话发送的背景仅保留名称和参与角色等最小字段，不带账号 ID、人物记忆或原会话来源 ID。
