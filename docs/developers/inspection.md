---
title: 持续 Agent 领域检视
description: 观察、原生工具循环、行动、Memory 历史与环境控制的只读接口及证据边界。
---

# 持续 Agent 领域检视

领域 Inspection 把已经保存的观察、模型步骤和执行回执连接起来，帮助解释一次运行使用了什么输入、停在哪个阶段，以及结果得到什么证据支持。接口复用 Gateway management 认证，全部为 GET，响应设置 `Cache-Control: no-store`。数据库读取在 `REPEATABLE READ READ ONLY` 事务中完成，不冻结新观察、不推进消费者，也不恢复或取消任务。

本页描述服务端接口。前端领域工作台由后续 UI 工作接入；现有模块记录浏览器继续使用原接口。

## 请求、分页与读取时间

路径均相对于 `/api/v1/inspection`，成功响应为 `{data: ...}`。数据库领域接口要求 `scope`，取宿主派生的规范 scope 字符串。聊天 scope 是平台、适配器、目标类型和目标 ID 的 JSON 数组，不能用旧显示名称代替。scope 限定关联数据的范围；当前认证仍是共享管理权限，不是按用户划分的租户授权。

列表支持 `limit`（1–50，默认 20）与 `cursor`。观察、进度列表另支持 `consumerId`。签名游标绑定路由、scope、消费者、首屏上界和窗口成员；重启或刷新 Inspection 服务后应重新读取首屏。过滤条件改变、游标被修改时返回 `400 invalid_cursor`。

**boundary** — 首屏的账本位置与数据库读取时间，用于限制候选记录。序号或时间戳可能先于事务提交，因此接口还校验目录窗口成员。上界内有迟到提交改变窗口时返回 `409 inspection_directory_changed`，客户端应刷新首屏。

**directory** — 列表只保留最多 500 个候选身份，另读一个身份判断截断。观察窗口选择最近登记的 500 条，页面按 observation ID 倒序；运行、行动和 GUI 任务按账本位置倒序；进度按 stream ID 倒序。`directory.truncated=true` 表示窗口外还有记录。窗口耗尽时 `nextCursor=null`，不代表全部历史已经读完；已知身份的详情不受目录窗口限制。

**stateReadAt** — 每次响应读取当前状态的时间。目录成员固定并不把行动状态、进度水位或当前 Memory 失效状态冻结在首屏时刻。每一页内部来自同一数据库快照。

**truncated / nextCursor** — 当前窗口还有下一页时返回游标。数组另有各自的截断字段。Memory 历史会排除不属于冻结知识范围的记录；空 `items` 与非空 `nextCursor` 可以同时出现。

## 从观察追到行动

**`GET /observations` 与 `/observations/:id`** — 返回观察的消费方、策略版本、范围、完成状态、重试记录和原冻结 manifest。详情连接原来源及基于该观察的 native run、行动和 GUI 任务。manifest 读取原保存值，再进行脱敏与有界内容投影，不用今天的配置重建。

**`GET /progress`** — 分别返回连续成功水位、已发现水位、已分配水位、未完成观察及 backlog 区间。不同消费者拥有独立进度；发现过某条消息不表示已经成功消费。最多返回 100 个缺口，并用 `holesTruncated` 标记省略。

**`GET /sources/:id`** — 在匹配范围内读取原来源与引用。缺失或跨范围身份统一返回 404；来源证明缺失、当前撤回或身份拆分分别返回不可用原因。运行、模型、行动和迟到 MCP 事实只返回身份元数据，正文标为 `domain-detail-required`，通过下列领域详情读取经过配对验证的内容。

**`GET /runs` 与 `/runs/:id`** — 保留 native `runInformationId` 与 `actionRunInformationId` 两个身份。逐步列出冻结、请求、dispatch、模型终态以及 tool call → intent → receipt → result 关联。仅配对有效时显示结果；结果内容必须等于原回执投影或正式的输出预算截断投影。旧 run 可以通过持久 `origin_key` 读取取消证据。

模型完成、工具结果、任务停止和取消转发分别展示。`dispatched-without-terminal` 来自保存的 typed `reasonCode`；`model-outcome-unknown` 保留未知语义。请求的 `contextTrimming` 原样给出测量方式、省略段数和字节预算，缺失时为 null。该统计测量追加当前 Prompt 之前的 native message array，不代表完整请求体大小。

**`GET /actions` 与 `/actions/:id`** — 返回原 intent、当前状态、原执行与 reconciliation 回执、取消引用和经过匹配的迟到 MCP 证据。receipt 复用正式行动回执证明，验证注册身份、kind、原 intent、attempt、started 引用与结果摘要；GUI 回执还验证 artifact 归属、generation、哈希和图像元数据。迟到数据还核对 scope、连接及定义版本、transport generation、类型化 RPC 身份与原操作关联。拒绝的候选计入 `rejectedEvidenceCount`。迟到数据本身不会把 unknown/partial 改为成功。

native run 最多返回 32 个步骤与 128 个调用，行动最多返回 100 个回执和 100 条迟到证据；每组独立标记截断。`admittedSteps`、`registeredCalls` 和 `projectedOutputBytes` 是持久预算计数，不是成功次数。

## 读取当时可知的 Memory

`GET /memory/:id/history` 要求 `observationId`。可选 `stepInformationId` 必须是该观察对应 native run 的真实已索引步骤。接口使用原观察或该 successor 冻结的 publication cutoff；后来的修订不会补进原观察。

每项同时给出 revision、publication 身份、历史状态和当前可用性。正文只在历史来源归属证明、依赖和当前撤回/身份拆分检查通过后返回。旧数据没有证明时标为 `source-proof-missing`；历史 publication 保持不变。未记录知识上界返回 `409 inspection_knowledge_boundary_unrecorded`。

其他详情中的 native Memory 节点仅保留 `nodeId` 与 `revision`，并在 `omitted` 中标记 `memory-node-content:use-history`。读取节点正文须走本接口，使 observation、step 和正规 Memory 来源入口遵循相同的证明边界。冻结 pendingEvidence 仅显示原始来源身份与时间；原始入站记录仍可通过认证后的来源接口审计。Memory source-withdrawal 禁止把该来源继续作为可用记忆证据，不删除原始审计记录。

每个 revision 的依赖展开最多 256 个节点、1024 条边。超出证明预算返回 `409 inspection_dependency_budget_exceeded`，避免把部分依赖当成完整有效性证明。

## GUI 任务与人工控制

**`GET /gui-tasks` 与 `/gui-tasks/:id`** — 详情 ID 是列表中的 `requestedInformationId`，保留用户 `taskRequestId`、原 observation、action run、环境 generation 和 native run 关联。`terminalSource` 区分实际 GUI 终态、native run 投影、执行耗尽和未记录；相互冲突的身份返回 409。取消的 pending/forwarded 独立于 queued/running/completed/failed/stopped。

**`GET /environments/:id`** — 从现有宿主只读门面读取当前控制状态，包括 human、draining、quarantined、isolation_failed、generation 与 pendingControl。宿主未装配时返回 503。

**`GET /environments/:id/operations/:operationId`** — 查询已知人工操作的回执。当前接口不提供未持久化的历史操作目录，也不读取 broker 私有文件。控制与停止继续使用原环境管理接口。

GUI clean 说明输入进程与 X11 清理完成；文件哈希验证说明当前文件状态。`current-file-state`、`latest-input-window` 和 `causalAttribution=unconfirmed` 保留原证据含义，不据此推断某次 GUI 操作造成了文件变化。

## 内容与错误契约

安全正文使用 `{value, omitted, truncated}`。每份正文限制深度、集合大小及字符预算，并移除 Prompt、原生消息、绑定、凭据、私有路径、container/kernel 隔离证据和图像数据。顶层字段再次经过秘密脱敏；provider 回执标识也执行路径与 URL 凭据清理。截图沿用带认证的图片路由。

引用最多显示 100 项，并给出 `available`、`missing-or-denied` 或 `invalid` 等状态。缺失、跨 scope、旧记录证明缺失、正文省略和数组截断分别表达，不用空正文冒充没有历史。数据库驱动异常不会进入 HTTP 错误正文。

测试通过真实 HTTP 路由在独立 PGlite 与 PostgreSQL schema 上检查只读事务、认证、窗口与过滤、来源证明、结果配对和内容清理。领域 fixture 直接构造持久事实，验证读取投影与证明边界；完整生产写入链路另行验收。fixture 先等待写入完成再读取，退出时尝试关闭全部应用及数据库，再汇总清理错误；测试不调用外部模型或生产服务。
