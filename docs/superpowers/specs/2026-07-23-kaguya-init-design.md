# Kaguya Init Commit 设计

## 目标

Kaguya 的首次提交要交付一个 TypeScript、pnpm monorepo 项目。项目以事件图和工作流为核心，抽象 MaiBot 的消息处理、心跳、定时记忆整理、Prompt 组装与 LLM 调用链。

本次提交必须做到：

- 研究并记录 MaiBot 的 LLM 请求入口、Prompt 来源、事件字段和触发关系。
- 提供定义事件、监听器、节点、边和工作流的 SDK。
- 跑通消息路由、短间隔心跳和长间隔记忆整理三类工作流。
- 持久化消息、记忆、事件运行记录和 LLM 请求追踪。
- 使用确定性的测试 LLM 跑通示例，不要求开发者配置 API key。
- 使用 promptfoo 验证关键 Prompt。
- 提供构建、测试和新增子包说明。

社交平台适配器、Web UI、文档站、Computer Use 和插件生态兼容不在本次范围内。

## 技术基线

- Node.js 24.18.0 LTS。
- `.nvmrc` 和 `.node-version` 固定为相同的 Node.js 版本，同时兼容 nvm 和 fnm。
- pnpm workspace 管理依赖和任务。
- TypeScript strict mode 与 project references。
- Vitest 执行单元测试和集成测试。
- ESLint 与 Prettier 执行静态检查和格式检查。
- promptfoo 执行 Prompt 回归测试。
- Node.js 内置 `node:sqlite` 的 `DatabaseSync` 作为本地 SQLite 驱动，不引入 ORM；SQL、迁移和行映射只存在于 database 包内部。
- Vercel AI SDK Core 作为统一 LLM SDK；测试和 demo 使用 `ai/test` 提供的 mock model。

## Monorepo 划分

```text
apps/
└── demo/
    └── 以确定性测试 LLM 运行三类工作流

packages/
├── schema/
│   └── 事件、消息、Prompt、LLM trace 与持久化记录的共享 schema
├── sdk/
│   └── defineEvent、defineListener、defineNode、defineWorkflow 等公开开发接口
├── engine/
│   └── 事件队列、监听器调度、图执行器、运行状态和失败记录
├── scheduler/
│   └── heartbeat 与 cron 触发器
├── prompt/
│   └── Prompt 来源加载、排序、组装和来源追踪
├── llm/
│   └── LLM SDK 适配、请求/响应归一化和确定性测试客户端
└── database/
    └── 消息、记忆、事件运行记录和 LLM trace 的 SQLite 存储
```

依赖必须保持单向：

```text
apps/demo
  ├── sdk
  ├── engine
  ├── scheduler
  ├── prompt
  ├── llm
  └── database

sdk ───────→ schema
engine ────→ schema
scheduler ─→ schema
prompt ────→ schema
llm ───────→ schema
database ──→ schema
```

基础包之间通过 schema 中的类型和应用层注入的接口协作。任何基础包都不能导入 `apps/demo`，具体 LLM SDK 和 SQLite 实现不能泄漏到其他包。

## 事件模型

所有事件使用统一信封：

```ts
export interface EventEnvelope<TType extends string, TPayload> {
  id: string;
  type: TType;
  source: string;
  occurredAt: string;
  traceId: string;
  sessionId?: string;
  payload: TPayload;
  metadata: Record<string, unknown>;
}
```

字段语义：

- `id` 唯一标识一次事件。
- `type` 标识事件类型。
- `source` 标识适配器、调度器或工作流节点等触发来源。
- `occurredAt` 使用 ISO 8601 UTC 时间。
- `traceId` 串联同一次消息、心跳或定时任务产生的全部事件和 LLM 请求。
- `sessionId` 在会话相关事件中必填，在全局定时事件中可省略。
- `payload` 是由事件定义约束的业务数据。
- `metadata` 只放不参与核心业务判断的扩展信息。

初始事件至少覆盖：

- `message.received`
- `message.persisted`
- `heartbeat.tick`
- `memory.schedule.tick`
- `route.requested`
- `route.decided`
- `prompt.compiled`
- `llm.requested`
- `llm.completed`
- `llm.failed`
- `memory.write.requested`
- `memory.written`
- `reply.generated`

监听器分为两类：

- 拦截监听器按优先级串行执行，可以改写事件或停止后续处理。
- 观察监听器在核心流程完成后执行，不能修改流程结果；观察监听器失败会被记录，但不反向破坏已经完成的业务节点。

## 工作流模型

SDK 用节点和有向边声明工作流。节点接收类型化输入和运行上下文，返回类型化输出；边根据上游结果选择下游节点。引擎负责拓扑校验、运行、追踪和失败记录。

每个工作流定义必须满足：

- 节点 ID 在工作流内唯一。
- 边的起点和终点必须存在。
- 不允许没有显式循环策略的环。
- 每个节点运行结果都写入同一个 `traceId`。
- 节点失败时记录失败节点、错误分类和可重试性。
- 测试可注入时钟、ID 生成器、数据库和 LLM 客户端。

## 三条初始工作流

### 消息更新工作流

```text
message.received
→ 保存用户消息
→ 读取最近 N 条对话
→ 读取 persona、memory 和 route policy
→ 组装 route Prompt
→ LLM 判断是否回复
→ [需要回复] 组装 reply Prompt
→ LLM 生成回复
→ 保存回复和完整 trace
```

### 心跳工作流

```text
heartbeat.tick
→ 读取最近历史和短时状态
→ 组装 state Prompt
→ 更新情绪、用户关系和短时记忆
→ 运行一次 route 判断
→ [需要主动回复] 进入回复生成链
```

心跳测试通过手动 tick 或假时钟触发，不使用真实等待。

### 定时记忆工作流

```text
memory.schedule.tick
→ 读取时间窗口内的聊天记录
→ 读取 memory policy
→ 组装 memory Prompt
→ LLM 提取长期记忆
→ 写入数据库
```

定时任务默认演示每日执行，但调度表达式必须可配置。

## Prompt 组装与追踪

每个 Prompt 由带来源信息的片段组成：

```ts
export interface PromptFragment {
  id: string;
  source: "template" | "history" | "memory" | "persona" | "policy" | "state";
  priority: number;
  content: string;
  metadata: Record<string, unknown>;
}
```

Prompt 编译器按明确的优先级和稳定顺序组装片段，并返回：

- 最终发送给 LLM 的消息。
- 每个片段的来源、顺序和内容摘要。
- 对应工作流、节点、事件和 `traceId`。

route、reply、state 和 memory 四类 Prompt 分开定义。promptfoo 至少覆盖：

- route Prompt 包含历史、persona、memory 和 route policy。
- reply Prompt 不包含只供路由使用的内部说明。
- state Prompt 包含短时状态更新规则。
- memory Prompt 只读取指定时间窗口中的消息和 memory policy。

## LLM 边界

`llm` 包基于 Vercel AI SDK Core 提供统一客户端接口，并在内部适配具体 provider。业务工作流不能直接导入供应商 SDK。

每次调用都记录：

- 请求类别和模型标识。
- 归一化消息。
- Prompt 片段来源。
- 开始时间、结束时间和耗时。
- 响应或结构化错误。
- token usage（供应商返回时记录）。
- `traceId`、工作流 ID 和节点 ID。

测试客户端使用 `ai/test` 的 mock model，根据请求类别返回确定性结构化结果，使 demo、测试和 promptfoo 不依赖网络或密钥。

## 数据库边界

database 包使用 Node.js 内置 `node:sqlite` 管理 SQLite schema、迁移、参数化 SQL 和 repository 实现，不引入 ORM。初始 schema 包含：

- `messages`
- `memories`
- `event_runs`
- `llm_traces`

应用通过 repository 接口访问数据，不直接拼接 SQL。测试使用独立的临时数据库，demo 使用仓库忽略的本地数据文件。

Memory 在本次设计中是消息工作流和定时工作流读写的数据，不单独绑定某个 memory 框架。以后可以在不改变事件和工作流接口的前提下替换检索或存储实现。

## 错误处理

- schema 校验错误在进入事件队列前失败。
- 工作流定义错误在启动时失败。
- 节点运行错误写入 `event_runs`，并带有错误分类。
- LLM 错误归一化为可重试、不可重试和取消三类。
- 观察监听器错误只记录，不覆盖主流程结果。
- demo 遇到未处理错误时使用非零退出码。
- 禁止用空响应或静默 fallback 掩盖失败。

## 测试和验收

单元测试覆盖：

- 事件信封校验。
- 监听器优先级、改写和拦截。
- 工作流图校验与节点执行顺序。
- Prompt 片段稳定排序和来源追踪。
- 调度器的手动 tick 与取消。
- repository 的写入和读取。
- LLM 成功、失败和 trace 记录。

集成测试分别跑通三条工作流，并检查数据库中的消息、memory、事件记录和 LLM trace。

根目录必须通过以下命令：

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm prompt:test
pnpm demo
```

## 文档交付

- `docs/maibot-analysis.md`：MaiBot 的 LLM 请求入口清单、Prompt 来源、事件/监听器、心跳机制及 Mermaid 流转图。
- `docs/architecture.md`：Kaguya 包边界、依赖方向、事件字段、工作流定义和数据库划分。
- `CONTRIBUTING.md`：nvm/fnm 安装 Node、pnpm 安装、构建、测试、新增子包和提交前检查。
- `README.md`：项目定位、快速开始和文档导航。

最终保留用户已经创建的远端 MIT License 初始提交，并将本次全部开发内容整理为它上面的一个 `chore: initialize Kaguya monorepo` 提交；不推送远端。
