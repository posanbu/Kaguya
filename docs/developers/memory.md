---
title: Memory 认知层选型
description: Memory 原始文档、可重建向量与可替换认知层的边界。
---

# Memory 认知层选型

## ADR：采用独立 Mem0 REST 服务

**状态 — 已选择，接入实施中。** 对应 #90。原始消息只由 Kaguya 的 PostgreSQL MemoryStore 保存；认知服务不取得 Kaguya 数据库连接、模型密钥或全局账本读取权限。

选择 [Mem0 OSS](https://github.com/mem0ai/mem0) 作为首个可替换 provider，通过其 [REST API](https://github.com/mem0ai/mem0/blob/c7ee362aff94a369af70f13f2b4f853f6793ff4c/server/main.py) 独立部署。2026-09-12 核对的上游 revision 为 `c7ee362aff94a369af70f13f2b4f853f6793ff4c`，[许可证为 Apache-2.0](https://github.com/mem0ai/mem0/blob/c7ee362aff94a369af70f13f2b4f853f6793ff4c/LICENSE)。Kaguya 不复制、vendor 或改写 Mem0/A_Memorix 的演化源码。A_Memorix 的 AGPL 与 Alpha 部署评估不纳入本次默认接入。

**部署 — 独立服务。** Mem0 自行管理其 LLM、embedding、向量和历史后端；只在 selected Profile 显式启用时调用。服务凭据由宿主持有，模块只能使用版本化 `MemoryCognitionProvider` capability。不得向在线 Prompt 暴露服务地址、密钥或原始异常。

**演化单位 — 有界证据快照。** 每次输入是同一 namespace、account、scope 内已持久化的有序原始文档窗口。provider 独立完成提取与冲突消解；Kaguya 不实现事实合并启发式。每个 operation 使用独立上游命名空间，避免服务隐藏历史把未授权来源带入结果。派生快照保留完整的直接 source Information 引用，按证据截止时间选择最新的已完成快照，旧快照仍可审计。

**恢复 — 本地唯一终态。** 网络超时交给 Reliable Runner 有界重试；远端可能已经执行的请求允许重放，本地只接受一个有效快照。上游 REST 不提供跨网络的 exactly-once 事务保证，因此不把远端内部对象当作 canonical Memory。provider 故障不会影响 raw Memory 的写入和稀疏召回。

**边界 — 不建立第二事实源。** 派生结果只在明确选择、重载证据和校验 scope 后进入 Prompt。向量索引单独保存模型、revision、维度；既不执行事实演化，也不改变 canonical 文档。
