---
title: 使用 Web UI
description: 通过同源 Web UI 管理 Profile、提交消息并理解当前响应边界。
---

# 使用 Web UI

`apps/web` 是 React/Vite 客户端，由统一 Kaguya Server 同源提供。页面、健康检查和 API 默认都位于 `http://127.0.0.1:3000`，不需要再启动一个 Web 服务。

## 打开页面

先按[安装与启动](./installation)运行 Server。成功监听后，终端会打印类似下面的完整访问链接：

::: code-group

```text [默认地址 ~vscode-icons:file-type-url~]
Kaguya access URL: http://127.0.0.1:3000/#gatewayToken=<本次启动生成的 token>
```

:::

开发模式把 Vite middleware 与热更新挂在 Fastify 内；生产模式由 Fastify 提供 `apps/web/dist`。

## 页面如何决定显示内容

页面只从 `#gatewayToken=` fragment 读取 token，再携带 Bearer 认证请求 `/api/v1/profiles`，取得 selected Profile 的 readiness 和 Profile 摘要。随后进入以下状态之一：

**访问受限** — 根地址没有 token，或链接来自上一次 Server 启动；页面要求重新打开当前终端中的完整链接。

**检查中** — 等待 Server 返回配置状态。

**Profile 管理** — 所选配置无效或仍需确认；可以创建、编辑、选择和删除 Profile。

**等待重启** — 新的所选配置已经写盘，但 Runtime 仍需重启才能采用。

**消息界面** — 配置为 ready，可以提交文本。

**错误** — 服务不可达或请求失败；页面给出错误并允许重新加载。

界面状态和设计约束见[配置流程设计](../design/configuration-flow)。

## Gateway Token 与访问边界

Gateway Token 保护 Profile readiness、Profile 管理、NapCat 和消息接口。Server 每次启动生成新的全权限 token，并只通过监听成功后打印的 URL 交给用户。前端保留 fragment 以支持刷新，只在页面内存中使用 token，不写入浏览器存储。fragment 不随 HTTP 请求或 Referer 发送，前端会显式把 token 放入 `Authorization` 请求头。

Server 只允许监听 selected Profile `runtime.host` 中的 `127.0.0.1`、`localhost` 或 `::1`；其他值会拒绝启动。完整访问链接等同管理权限，请勿分享。

## 管理 Profile

进入 Profile 管理后，先在列表中选择要编辑的 Profile，再填写名称、Base URL、API Key、light model、heavy model 与网关白名单，并选择是否启用 Memory。白名单文本框每行一条 `platform:group|private:target_id` 规则；保存时会修剪每行并移除空行，但保留重复或非法的非空行。Memory 默认关闭；关闭态不会向回复返回实际 Memory 信息。保存 selected Profile 或切换 selected Profile 后，按页面提示重启 Server。

`default` Profile 不能删除；当前 selected Profile 也不能删除。创建新 Profile 会继承 selected Profile 的隐藏 runtime，但不会自动选中或改变正在运行的 Runtime。Web 不展示、返回或修改数据库 URL 等 runtime 字段，只把 gateway allowlist 作为安全顶层字段编辑。字段含义与操作顺序见[配置 Kaguya](./configuration)。

## 提交消息

消息界面目前只接受文本。提交后页面可能显示 accepted，并附带 requestId；这表示 Web gateway 已接收请求并开始后台分发，不表示 Runtime 已完成、模型已生成回复或平台已经投递。

Web gateway 会把输入规范化为 `web` 平台消息，使用 `web:${requestId}` 作为 traceId，然后异步调用 Runtime。当前没有回复查询接口或 SSE，所以页面不会显示真正的模型回复流。

::: info accepted 不是聊天回答
`202 accepted` 是接收确认。若要验证后台处理，需结合 Server 日志、PostgreSQL 信息账本或接入具备 outbound transport 的平台。
:::

## 常见操作结果

**401 unauthorized** — Token 与当前 Server 实例不一致。页面会切换到访问受限状态；从当前 Server 终端重新打开完整链接。

**503 runtime_unavailable** — Runtime ingress 不可用或 Server 正在停止。进入 Gateway / Adapter 查看原因，修复后重启。

**accepted 但没有回答** — 属于当前 Web 协议的正常边界，不是前端伪造失败。

**Web UI 可用但 NapCat 不响应** — HTTP/Web 与 NapCat 生命周期相互隔离；检查 `module=adapter:napcat` 日志。

更完整的定位步骤见[故障排查](./troubleshooting)。

## Gateway / Adapter

配置页入口展示 Host、Runtime ingress 以及 Web、NapCat 的独立状态，保留 NapCat 配置表单。连接成功不代表能处理消息，修复配置或下游故障后需重启。页面可见时每两秒刷新，离开或隐藏时停止，支持手动刷新。请求失败后保留最后快照，并显示失联提示及最后获取时间。

## 模块配置与 Prompt 模板

在“检查 → 模块”打开独立详情页，可以编辑模块声明的全局配置与模板。顶栏 Profile 选择器不会切换模块配置文件；模块实例的配置启用状态也只在保存并显式应用后影响运行实例。

**全局模块配置** — 字段名称、说明、默认值和约束来自模块自己的 settings schema。保存失败保留输入；字段错误显示在对应控件旁。保存成功后，到生效管理显式应用当前配置。`botNames` 由 Profile 身份提供，因此显示为只读。没有持久化配置的模块不会因打开页面自动创建配置文件，运行状态仍在详情中展示。

**版本冲突** — 如果其他页面先保存了同一实例，旧版本保存会被拒绝。复制需要保留的输入后，选择重新读取，再重新编辑。重新读取会明确确认是否放弃未保存内容。

**Prompt 模板** — 页面只展示模块显式声明的源码、用途、允许变量与组成关系，不提供带用户消息或 Memory 的渲染预览。消息编写模块拥有主模板、历史、记忆、引用与轮次模板；Heartflow 拥有 Planner 模板。没有声明的模块显示无需编辑。

**本地覆盖与恢复默认** — 保存创建或更新 `*.local.hbs`，内置默认值保持只读。恢复默认删除对应本地覆盖。保存或恢复后请重启服务；模板变更尚不参与配置应用 revision。模板组的并发版本覆盖整组内容，其他页面修改组内任意模板都会使旧版本失效。

模板仅允许声明的变量、静态 partial 及 `each`、`if`、`unless` 块。未知变量、动态或未知 partial、不支持的 helper、空白模板、语法错误和循环依赖均在写入前拒绝。若编辑器报错，按附近提示修正后再保存；错误不会清除草稿。

## 按需查看说明与诊断

页面标题下的“页面说明”默认折叠；错误与需要处理的状态保持直接可见。状态使用图标、文字和底色共同表达，主操作、次要操作与危险操作分层展示。

检查区的模块总览可切换“列表”和“信息流”。信息流按 Manifest 展示所选模块的上下游，点击相邻模块继续追踪；“已激活”来自当前绑定，并不代表它已经处理了某条消息。模块详情的输入、输出说明可逐项展开。

模块详情优先展示运行记录。注意力模块显示门控结果、当时分数、阈值、原因及策略版本；心跳、回合编排和持续关注分别提供唤醒、规划与租约历史。身份、表达学习和认知模块提供持久化实体、习惯批次与快照视图。记录可按类型、当前实例和时间范围筛选，点击“查看详情与来源”沿正反引用追溯。

Memory 写回与索引模块的“数据存储”直接读取文档库和向量索引元数据。可选索引尚未建立时显示不可检查；模块未激活也可以查看留下的历史和共享数据。表达库按学习批次展示，不把跨批次重复习惯计为全局唯一记录。所有“本页”数量均不是全库统计，历史预约和租约也不代表当前仍在生效。

“运行机制”“模块职责与输入输出”“模块配置”和“提示词模板”按需展开。Atom 详情先展示可读字段，完整字段、编译 Prompt 和原始 JSON 可另外展开；摘要被截断时保留明确提示，完整脱敏内容仍在详情中。

消息流默认显示时间列表，同时提供图形视图。阶段摘要包含身份、记忆和模型任务，并显示已观察的明确决策结果。“导出诊断”只保存当前有界视图的节点元数据、引用和截断标记，不导出正文、可读字段或 Prompt。窄屏下拓扑按上游、当前模块、下游的顺序排列。
