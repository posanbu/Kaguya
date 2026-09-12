---
title: Memory 认知层选型
description: Memory 原始文档、可重建向量与可替换认知层的边界。
---

# Memory 认知层选型

## ADR：采用独立 Mem0 REST 服务

**状态 — 已实现。** 对应 #90。原始消息只由 Kaguya 的 PostgreSQL MemoryStore 保存；认知服务不取得 Kaguya 数据库连接、模型密钥或全局账本读取权限。

选择 [Mem0 OSS](https://github.com/mem0ai/mem0) 作为首个可替换 provider，通过其 [REST API](https://github.com/mem0ai/mem0/blob/c7ee362aff94a369af70f13f2b4f853f6793ff4c/server/main.py) 独立部署。2026-09-12 核对的上游 revision 为 `c7ee362aff94a369af70f13f2b4f853f6793ff4c`，[许可证为 Apache-2.0](https://github.com/mem0ai/mem0/blob/c7ee362aff94a369af70f13f2b4f853f6793ff4c/LICENSE)。Kaguya 不复制、vendor 或改写 Mem0/A_Memorix 的演化源码。A_Memorix 的 AGPL 与 Alpha 部署评估不纳入本次默认接入。

**部署 — 独立服务。** Mem0 自行管理其 LLM、embedding、向量和历史后端；只在 selected Profile 显式启用时调用。服务凭据由宿主持有，模块只能使用版本化 `MemoryCognitionProvider` capability。不得向在线 Prompt 暴露服务地址、密钥或原始异常。

**演化单位 — 有界证据快照。** 每次输入是同一 namespace、account、scope 内已持久化的有序原始文档窗口。provider 独立完成提取与冲突消解；Kaguya 不实现事实合并启发式。每个 operation 使用独立上游命名空间，避免服务隐藏历史把未授权来源带入结果。派生快照保留完整的直接 source Information 引用，按证据截止时间选择最新的已完成快照，旧快照仍可审计。

**恢复 — 本地唯一终态。** 网络超时交给 Reliable Runner 有界重试；远端可能已经执行的请求允许重放，本地只接受一个有效快照。上游 REST 不提供跨网络的 exactly-once 事务保证，因此不把远端内部对象当作 canonical Memory。provider 故障不会影响 raw Memory 的写入和稀疏召回。

**边界 — 不建立第二事实源。** 派生结果只在明确选择、重载证据和校验 scope 后进入 Prompt。向量索引单独保存模型、revision、维度；既不执行事实演化，也不改变 canonical 文档。

## 配置和启用

`memory.enabled` 默认 `false`。单独设为 `true` 会启用可靠原始写回与稀疏召回；embedding 与 cognition 都是可选项。以下是 Profile 的 Memory 片段，凭据应替换为自己服务的值，不应提交到 Git。Web 表单只显示总开关，provider 配置通过受保护的 Profile JSON 管理。

::: code-group

```json [Profile 片段 ~vscode-icons:file-type-json~]
{
  "memory": {
    "enabled": true,
    "embedding": {
      "providerId": "local-embeddings",
      "modelId": "configured-embedding-model",
      "revision": "deployment-v1",
      "dimensions": 1536,
      "baseUrl": "http://127.0.0.1:8001/v1",
      "apiKey": "replace-locally"
    },
    "cognition": {
      "provider": "mem0-rest",
      "revision": "deployment-v1",
      "baseUrl": "http://127.0.0.1:8000",
      "apiKey": "replace-locally"
    }
  }
}
```

:::

Mem0 服务需要支持 `POST /memories` 的 `infer`、`user_id`、`run_id`、`metadata`，以及 `GET /memories` 的同名过滤与 `top_k`。部署与凭据由服务端管理，Kaguya 不启动该服务，也不把自身模型密钥交给它。适配器要求返回的 `user_id` 与 `metadata.sourceInformationIds` 对应本次操作；不符合契约时拒绝结果。每次认知最多读取 32 条同范围已入库消息，返回最多 32 条事实，超时为 30 秒。它保留完整输入窗口作为保守的来源集合，不把集合引用声称为逐句语义验证。

## 原始消息写回

`agent.memory.writeback` durable 消费身份终态，用原始 inbound Information ID 登记唯一 request。Web ephemeral 与 canonical 消息都写入，人物 ID 不作为 Memory 主键。正文仅保存在原始文档，request/terminal 不复制正文。空正文、非法输入与来源冲突有明确终态；数据库瞬时错误由 Reliable Runner 有界重试，stop 保留 pending。

composition 在 Memory 开启时补入写回实例；存在显式配置时尊重其 `enabled`。index/cognition 实例只在相应 provider 存在且总开关开启时加入。没有在线 Heartflow、Heartbeat、Composer 也能验收后台闭环。

## 向量与混合召回

向量是可选投影表 `memory_document_vectors`。Runtime 只在显式配置 embedding 时尝试准备 pgvector；扩展不可用时记录稳定状态，原始写回与 sparse recall 保持可用。标准托管 `postgres:17-alpine` 镜像不包含 pgvector；需要向量功能时，应自行准备安装了 pgvector 的 PostgreSQL 17，并通过 external database 配置接入，不替换现有托管卷。

每条向量使用 `memoryId + modelId + revision + dimensions` 唯一键。稀疏和向量分别在同一 namespace/account/scope、截止时间与排除来源约束内取 Top-K，以 RRF 融合，再用 memoryId 稳定排序。在线模块显式传入冻结聊天范围。embedding 失败或维度不符时退化为稀疏结果。

启动时登记最多 50 条一页的历史回填；每页先提交逐文档 request 与 continuation，再提交页终态。模型/revision/维度变更会产生新的回填根，旧任务显式 superseded。重建被删除的派生索引，或在修复 exhausted 任务后重新处理全量历史时，使用新的 revision；不修改原始 MemoryDocument。

## 已完成认知与 Prompt

身份未解析或 ephemeral/Web 范围只保留原始消息，不进入长期认知。认知 request 只携带稳定 provider 身份、有序来源、范围和截止时间。worker 从 Memory 重载文档、验证来源后调用 provider，成功时登记文本和唯一完成终态。文本先提交但终态尚未完成的中间状态不会进入 Prompt。后续 Heartflow 选择同 provider/revision、同账号/范围、截止时间内的完整快照，并通过 Core 重载直接证据；原始消息仍独立参与召回。

认知是一个最多 32 条文档的有界窗口，不能作为无限历史画像。外部服务的事实质量与语义证据判断仍需部署方评估；本地自动化测试验证的是协议、来源/范围、失败隔离与恢复，不代替真实服务的质量评测。
