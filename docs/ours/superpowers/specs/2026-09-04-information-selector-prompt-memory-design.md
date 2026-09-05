# 基于 informationId 的 Selector、Prompt 与 Memory：设计规格

**状态：** 已确认，待实现

**日期：** 2026-09-04

**对应 Issue：** [#41 实现基于 informationId 的 Selector、Prompt 与 Memory](https://github.com/posanbu/Kaguya/issues/41)

**父 Issue：** [#33 消息持久化](https://github.com/posanbu/Kaguya/issues/33)

**直接依赖：** [#40 将 Core 与模块 SDK 迁移到信息 DAG](https://github.com/posanbu/Kaguya/issues/40)

## 问题与目标

#40 把入站消息、过滤、LLM、回复和投递迁移到持久化优先的信息 DAG，但当前 reply 路径仍直接根据 handler 已持有的 payload 构造 Prompt。Core 也只有面向基础设施的 `get`、`getMany` 和引用反查，没有一种受控方式让业务模块声明“本次模型调用究竟使用了哪些已落账信息”。如果后续模块直接按用户、群组或时间窗口拼接历史，系统会重新形成没有显式身份和引用的隐式 Session。

本次改造建立一个以 `informationId` 为唯一选择结果的 Selector 边界。Selector 可以通过受限只读账本显式发现信息，但 Core 负责校验其结果、按原顺序重新加载不可变原子，并拒绝未知、重复或未获本次选择授权的 ID。reply Prompt 的所有动态上下文均来自这些原子；Memory 也只是普通 information kind，并用引用记录生成时使用的输入。

最终默认行为保持刻意保守：默认 Selector 只选择当前已经通过过滤的 `core.reply.requested` 原子，不根据发送者、群组、目标、时间窗口或其他字段自动聚合历史。

## 范围与非目标

本次实现包括：

- SDK 的 `defineInformationSelector`、Selector 类型和 handler `context.select`；
- Core 执行的单次选择作用域、结果校验和有序加载；
- 按 kind、source、时间和引用关系进行的受限只读账本查询；
- 可注入的命名检索策略边界，但不内置具体检索算法；
- reply Prompt 从账本原子生成动态 fragment，并记录 `informationId` provenance；
- `core.llm.requested` 通过有序 `core:uses-context` 引用记录 Prompt 动态输入；
- `core.memory.text` kind 及其 `core:uses-context` 输入引用；
- 顺序、引用加载、缺失原子和并发读取测试；
- 对 `sessionId`、`contextKey` 和隐式历史聚合的架构扫描。

本次不实现：

- 用户、群组、租户或角色权限系统；
- Session、conversation、thread 或长期上下文桶；
- 默认历史回看策略；
- Memory 自动生成、定时总结、淘汰、合并或去重策略；
- 向量数据库、embedding、reranker 或内置全文检索；
- Selector 运行事实的持久化。本期通过 LLM request 的引用审计实际使用的输入，若以后需要审计候选集合或选择理由，可另行增加 selection decision kind；
- 持久队列、自动补投、重试或跨进程 Selector 作业。

## 选定方案

采用“Core 执行 Selector，并为每次执行创建独立能力作用域”的方案。

未采用仅检查 ID 是否存在的简单方案，因为该方案无法区分显式选择和从闭包、缓存或硬编码中注入的既有 ID，也就无法满足越权结果明确失败。未采用每次选择都持久化 `selection.decision` 原子的方案，因为当前验收只要求 Prompt 的实际输入可由引用追溯；引入新的选择生命周期会增加不必要的 kind 和失败语义。

这里的“越权”是架构完整性边界，不是访问控制：Selector 只能返回当前输入，或本次执行中由受限读取器实际返回的原子 ID。它能发现错误的闭包状态、并发串线和绕过读取器的 ID 注入，但不会阻止一个受信任 Selector 主动发起范围较宽的结构化查询。

## SDK 契约

SDK 新增独立的 Selector 契约，概念接口如下：

```ts
export interface InformationSelectorDefinition {
  readonly selectorId: string;
  select(
    context: InformationSelectorContext,
  ): readonly InformationId[] | Promise<readonly InformationId[]>;
}

export interface InformationSelectorContext {
  readonly sourceAtom: DeepReadonly<InformationAtom>;
  readonly ledger: InformationSelectorLedger;
}

export function defineInformationSelector(
  definition: InformationSelectorDefinition,
): InformationSelectorDefinition;
```

`defineInformationSelector` 拒绝空白 `selectorId`，复制并冻结 definition；Selector 回调返回值只能是有序的 `informationId` 数组，不能返回原子、payload 或 Prompt fragment。

`InformationModuleHandlerContext` 增加：

```ts
select(
  selector: InformationSelectorDefinition,
): Promise<readonly DeepReadonly<InformationAtom>[]>;
```

Selector 本身只决定 ID；`context.select` 返回 Core 最终从账本重新加载并深度冻结的原子。业务模块不接触 Core、数据库 repository 或原始事务。

## 受限只读账本

Selector 读取器只暴露结构化、有限量的查询：

```ts
export interface InformationSelectorLedger {
  find(
    query: InformationFindQuery,
  ): Promise<readonly DeepReadonly<InformationAtom>[]>;

  related(
    query: InformationRelatedQuery,
  ): Promise<readonly DeepReadonly<InformationAtom>[]>;

  retrieve(
    query: InformationRetrievalQuery,
  ): Promise<readonly DeepReadonly<InformationAtom>[]>;
}
```

`find` 支持精确的 kind 集合、source 集合和发生时间上下界。查询必须至少给出一种过滤条件，并提供 `1..1000` 的整数 `limit`。时间范围采用半开区间：`occurredAt >= occurredAfter` 且 `occurredAt < occurredBefore`。默认排序为 `occurredAt ASC, informationId ASC`。

`related` 执行一跳引用读取，起点 ID 必须已经属于本次授权集合。`outgoing` 沿起点原子自身的 references 读取目标，按调用方起点顺序和 reference ordinal 排序；`incoming` 查询指向起点的原子，按起点顺序、`occurredAt` 和 `informationId` 排序。可选 relation 只匹配精确关系。多个起点发现同一原子时，读取结果稳定去重；Selector 最终结果仍独立执行重复校验。

`retrieve` 按 `strategyId` 调用 Core 启动时注册的检索策略。策略输入必须是 JSON-compatible 对象并提供 `1..1000` 的整数 `limit`。Core 不内置关键词、向量或 rerank 策略；不存在的 strategy 明确失败。策略返回的 ID 仍由 Core 从账本加载，缺失 ID 不会被静默忽略。

读取器不提供任意 `get(id)`。否则 Selector 只要知道或猜到一个 ID，就能先调用 `get` 再把它变成“已授权”，使越权检查失去实际意义。当前输入通过 `sourceAtom` 获得，其他信息只能由 `find`、`related` 或 `retrieve` 显式发现。

读取器不提供 register、append、update、delete、subscribe、原始 SQL、事务对象或底层 repository。每次返回的原子都是深度只读快照。

## Core 选择作用域与校验

Core 为每次选择调用创建局部作用域，禁止把授权集合存放在 Selector definition、ModuleHost 或 Core 的共享可变字段中。

执行顺序固定为：

1. Core 根据 handler 的 source `informationId` 从账本重新加载当前输入；缺失时抛出 source missing 错误，不使用 handler 对象兜底。
2. 创建 `authorizedIds`，只加入重新加载成功的 source ID。
3. 用本次作用域包装受限读取器。每次成功的 `find`、`related` 或 `retrieve` 都把返回 ID 加入 `authorizedIds`。
4. 执行 Selector，复制其返回数组，避免调用方事后修改。
5. 校验返回值形状和每个 ID 的 schema。
6. 在不改变顺序的前提下检查重复 ID。
7. 由 Core 批量读取全部返回 ID；任何不存在的 ID 以 unknown error 失败。
8. 检查每个已存在 ID 是否属于 `authorizedIds`；否则以 unauthorized error 失败。
9. 按 Selector 返回的 ID 顺序再次从账本加载原子。若第二次加载缺项，以 selected information missing error 失败。
10. 返回冻结的有序原子数组。

两次读取是有意设计。第一次将“未知 ID”和“账本中存在但未获授权的 ID”稳定区分；第二次保证业务模块接收的是 Core 最终确认的账本内容，而不是 Selector 查询阶段持有或伪造的对象。生产账本是 append-only，正常情况下已存在原子不会在两次读取之间消失；第二次缺失测试用于约束自定义、远程或故障注入 ledger 的行为。

错误分类使用稳定的独立类型，至少包括：

- `InvalidInformationSelectionError`：返回值不是合法 ID 数组；
- `SelectorSourceInformationMissingError`：作为选择起点的 source 原子无法从账本重新加载；
- `DuplicateSelectedInformationIdError`：同一 ID 出现多次；
- `UnknownSelectedInformationIdError`：Selector 返回账本中不存在的 ID；
- `UnauthorizedSelectedInformationIdError`：ID 存在，但本次选择未显式获得；
- `SelectedInformationMissingError`：最终重新加载时原子缺失；
- `InvalidSelectorQueryError`：过滤条件、时间范围、起点、方向或 limit 无效；
- `UnknownRetrievalStrategyError`：检索策略没有注册。

校验优先级固定为：形状与 ID schema、重复、未知、越权、最终缺失。Selector 回调自身抛出的异常保持原始 cause 向上传播；如果发生在模块 handler 中，沿用 #40 的 `consumer.failed` 语义，不创建另一套 Selector failure 原子。

## 并发与一致性语义

同一个 Selector definition 可以并发执行。每次调用单独创建 source、授权集合、读取器和结果数组；一次调用读取到的候选不会授权给另一次调用。

账本是 append-only，因此已读取原子的内容不会在选择期间被修改。本期不让任意 Selector callback 长时间占用数据库事务，也不承诺多个查询之间的数据库级 repeatable-read snapshot。并发新增原子是否进入某个查询，由该查询真正执行的时间决定；每一个单独查询必须保持确定性排序，最终 Prompt 顺序只由 Selector 返回的 ID 列表决定。

数据库 `getMany` 的内部返回顺序不得被当成契约。Core 以 `informationId` 建立映射，再严格按 Selector 列表重排。并发测试要使用 barrier 同时推进两个 selection，证明它们的授权集合和最终结果互不污染。

## 默认 Selector 与 reply Prompt

默认 Selector 定义为 `currentAcceptedMessageSelector`，行为只有：

```ts
select({ sourceAtom }) {
  return [sourceAtom.informationId];
}
```

它不调用 `find`、`related` 或 `retrieve`，不读取 sender、destination、group、时间范围或 `core:context` 下的其他原子。reply 模块还要求选择结果恰好包含当前 source ID 一次；自定义 reply Selector 如果遗漏当前输入，会在编译 Prompt 前明确失败。

reply handler 的数据流调整为：

```text
core.reply.requested
  -> context.select(selector)
  -> Core 从账本返回有序原子
  -> reply 模块把已加载原子映射成 Prompt fragments
  -> PromptCompiler 编译
  -> LLM lifecycle 注册 core.llm.requested
```

reply 模块不能从闭包、缓存、Session 或业务数据库补充动态上下文。它只负责把受支持的账本 kind 映射成 fragment：当前 reply 消息映射为 `history`，`core.memory.text` 映射为 `memory`；其他 kind 必须有显式 renderer，否则失败，不能使用 `String(payload)` 静默拼入。

共享 Prompt schema 为 fragment 和 provenance 增加可选 `informationId`。静态 template、persona 和 policy 可以不带 ID；由运行信息生成的动态 fragment 必须携带对应 ID。`PromptCompiler` 把 fragment 的 ID 复制到 provenance，而不自行推断来源。

`core.llm.requested` 增加可重复的 `core:uses-context` 引用，按 Selector 返回顺序写入。LLM lifecycle 从同一份有序原子数组同时构造 Prompt provenance 和 references，并在注册前检查两者 ID 完全一致，从结构上避免 payload 声明一组上下文、引用却记录另一组上下文。现有 `core:caused-by` 仍指向直接触发的 reply 原子，`core:context` 仍只表示当前运行 DAG；两者不替代 `core:uses-context`。

由此，一个 LLM request 可以通过自身 `informationId` 读取 payload 和有序引用，再逐项读取形成 Prompt 的原子，不需要 Session 或外部日志参与追溯。

## Memory 是普通信息 kind

新增 `core.memory.text`：

```ts
{
  text: string;
}
```

其引用契约包括：

- `core:caused-by`：必须且单个，指向直接触发 Memory 生成的输入；
- `core:context`：必须且单个，继承生成动作所在的运行 context；
- `core:uses-context`：必须且可多个，按生成时实际使用的输入顺序记录原子。

Memory 没有 `sessionId`、`contextKey`、用户历史桶或独立记录 ID。测试模块通过 `context.register(coreMemoryTextInformationKind, ...)` 写入 Memory，并显式提交 `core:uses-context` 引用。本期不默认启用 Memory 生成消费者；kind 和引用契约为后续业务模块提供稳定边界。

后续运行可以由自定义 Selector 通过 kind、source、时间、引用或检索策略显式发现该 Memory。跨 `core:context` 读取是允许的，因为 `core.runtime.context` 表示一次运行 DAG 而不是权限或长期会话边界。

## 持久化查询实现

`InformationLedger` 增加供 Core 内部选择执行器使用的结构化查询端口。PostgreSQL repository 使用参数化 SQL 实现，不向 Selector 暴露 driver。

现有 `(kind, occurred_at, information_id)` 和引用索引用于 kind、时间及 incoming reference 查询；新增 `(source, occurred_at, information_id)` 索引用于 source 查询。组合条件以精确匹配为主，不加入 payload JSON 任意查询。outgoing reference 读取使用账本中已加载原子的 reference ordinal，不需要递归 SQL。

查询结果逐个通过现有 information schema 解析并深度冻结。非法数据库行、缺失引用目标或检索策略返回未知 ID 均显式失败，不返回部分成功结果。

## 文件与职责边界

SDK 中新增聚焦的 `information-selector.ts`，并由 package 入口导出；`modules.ts` 只扩展 handler context。Engine 中新增聚焦的 Selector executor 与错误定义；`InformationCore` 提供编排入口，`ModuleHost` 只把 source 和 Core 选择能力绑定到 handler context。Database repository 只实现结构化持久化查询。Prompt package 只维护通用 fragment/provenance 编译，不依赖 modules 的业务 kind。Modules 定义默认 Selector、Memory kind 和 reply renderer。Runtime 的 LLM lifecycle 只负责持久化请求及其引用。

不进行与本 issue 无关的目录重构，也不修改 #40 已建立的 register/on、consumer failure、ingress 或投递语义。

## 测试策略

所有行为保留真实的 RED 和 GREEN 阶段，但开发期验证半径保持最小。

每个实现步骤先增加一个聚焦测试，运行精确测试文件或 `-t` 指定的单个用例，确认它因目标能力尚未存在或行为不符而失败；随后只写使该测试通过的最小实现，再运行同一测试确认变绿。RED 必须是预期的行为失败或类型缺失，不能把导入错误、语法错误或环境故障当作有效 RED。

开发过程中不在每个小步骤重复运行全仓库测试。跨包接口完成一个可审查边界时，可额外运行直接依赖包的测试文件。所有功能完成后才执行一次完整交付验证，以证明没有跨包回归。

聚焦测试覆盖：

- SDK definition 校验、冻结与只返回 ID 的契约；
- Core 保留选择顺序，拒绝重复、未知和越权 ID；
- source 与最终结果都从账本重新加载；
- find 的 kind、source、半开时间范围、limit 和稳定排序；
- incoming/outgoing 引用读取、relation 过滤和去重；
- 未知检索策略及策略返回缺失 ID；
- 两个并发 selection 的授权集合不串线；
- Selector 异常由现有 `consumer.failed` 记录；
- 默认 Selector 只返回当前 accepted reply；
- 多个已选择原子按相同顺序进入 Prompt provenance 和 `core:uses-context`；
- 不支持的 atom kind 不能被静默渲染；
- Memory 通过 `core:uses-context` 指向输入，并能被自定义 Selector 选入后续 Prompt；
- 生产源码中的 Memory、Prompt 和 reply 路径不存在 `sessionId` 或 `contextKey`；
- reply 模块不直接调用 repository、`core.get` 或 `core.getMany`；
- 默认 Selector 不按 sender、destination、group、时间或其他字段查询。

交付前完整执行：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

只有以上命令的最新输出全部成功，才能声称本 issue 完成。开发期的小半径 GREEN 不能替代最终全量验证。

## 与 #40 的衔接

#41 使用独立的 `feat/issue-41-information-selector` worktree，不修改 #40 的工作目录。设计文档可以先提交；代码实现等待 #40 owner 的最终 HEAD 稳定，再把该最终状态合入或重置为 #41 的实施基线。若 #40 后续调整 `InformationCore`、`ModuleHost`、information kinds 或 LLM lifecycle，#41 只在自己的分支适配最终公开边界，不回头改写 #40 的职责或保留临时兼容层。

实施必须保持破坏式单模型：不为旧 reply payload Prompt 路径增加长期 fallback，不并存 Selector 上下文和 Session 上下文，也不为了提前开发而建立第二套临时 ID 或包装层。
