# Kaguya 信息原子契约与 Kind Registry 设计

**状态：** 已确认

**日期：** 2026-09-01

## 为什么 Core 需要统一身份

Kaguya 当前分别用 `EventEnvelope.id`、`MessageRecord.id`、`EventRun.id`、
`LlmTrace.id` 和出站消息记录 `id` 表达 Core 中的事实。因果关系又依赖
`traceId`、`causationEventId`、`rootEventId` 以及散落在 `metadata` 中的引用。
同一条消息从接收、过滤、LLM 调用到投递会跨越多套身份和持久化模型，调用方必须知道
每张表和每种信封的特殊规则，日志也无法稳定地指向同一种对象。

本设计以不可变的 `InformationAtom` 取代这些平行身份。消息、运行上下文、过滤决定、
LLM 生命周期、Memory 契约、投递状态、运行状态和系统日志都成为不同 kind 的信息原子。
Core 内部事实只使用 `informationId` 作为身份；状态变化通过追加新原子表达，既不修改旧事实，
也不为日志或状态记录引入第二套 Core ID。

这是破坏性升级。旧 `EventEnvelope`、消息记录、运行记录、LLM trace、出站记录及 SQLite
仓储不会保留兼容层，也不会自动导入 PostgreSQL。

## 目标与边界

本次改造必须做到：

- 提供严格、不可变且可泛型推导的 `InformationAtom` 公共契约。
- 提供 `defineInformationKind` 和启动期 `InformationKindRegistry`；所有 kind 必须在 Core
  开始接收消息前注册 payload schema、引用规则和日志策略。
- 拒绝未知 kind、重复 kind、非法 payload、非法 relation、缺失引用、错误目标 kind、
  重复引用和 ID 冲突。
- 由 Core 生成不编码业务含义的 opaque `informationId`；测试可以注入确定性生成器。
- 使用 PostgreSQL 统一追加和查询原子，并由数据库约束强化引用完整性与不可变性。
- 让消息正文和系统日志正文以最多 168 个 Unicode 字符的安全预览进入控制台投影。
- 为 Memory 注册可持久化、召回、替代和失效所需的 kind 与 relation 契约。

本次不实现 Memory 检索、向量索引、排序、压缩或淘汰工作流。它也不提供 SQLite 到
PostgreSQL 的数据搬迁工具、持久化任务队列、跨进程订阅恢复或 exactly-once 消费保证。
Profile、provider、module、workflow、node、平台用户和平台消息的标识仍可作为各自领域中的
配置键或外部标识出现；它们不再充当 Core 事实的身份。

## 公共原子契约

共享 schema 包定义以下逻辑接口：

```ts
type InformationId = string & { readonly __brand: "InformationId" };

interface InformationReference {
  readonly relation: string;
  readonly informationId: InformationId;
}

interface InformationAtom<K extends string = string, P = JsonObject> {
  readonly informationId: InformationId;
  readonly kind: K;
  readonly occurredAt: string;
  readonly source: string;
  readonly payload: DeepReadonly<P>;
  readonly references: readonly InformationReference[];
}
```

`occurredAt` 必须是带时区的 ISO 8601 时间，写入 PostgreSQL `TIMESTAMPTZ` 后以 UTC ISO
字符串读回。`source` 是非空、命名空间化的事实来源描述，不是第二个身份字段。payload 必须
是 JSON object；schema 可以校验和规范化值，但最终结果中不得出现 `Date`、`Map`、函数、
symbol、`bigint`、循环引用或 `undefined`。

Core 在创建原子前结构化克隆 payload 和 references，创建后递归冻结整个返回值。调用方在
`append` 返回后修改原始输入，不能影响已提交或已返回的原子。数据库读取也必须重建新的冻结
快照，不能把 PostgreSQL driver 返回的可变对象直接暴露给调用方。

调用方不可以向追加命令提供 `informationId`。默认生成器使用 `randomUUID()`；UUID 只是当前
实现，不构成公共格式保证，调用方不得解析、拼接或按前缀判断 ID。`InformationIdGenerator`
作为 Core 构造依赖注入，测试可返回固定序列。生成器产生空值、非法值或已存在值时追加失败，
Core 不静默替换调用方可观察到的 ID。

## Kind 定义与 Registry 生命周期

`@kaguya/sdk` 提供声明函数：

```ts
const inboundTextKind = defineInformationKind({
  kind: "core.message.inbound.text",
  payloadSchema,
  references: {
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
  },
  log: {
    level: "info",
    project: projectInboundText,
  },
});
```

定义对象本身不可变。kind 使用点分命名，`core.*` 只允许内置定义使用。每个定义必须显式提供
payload schema 和日志策略；引用规则可声明 relation 是否必需、是否允许多个目标，以及目标
kind 集合。未声明的 relation 不能出现在该 kind 的原子中。

日志策略要么是 `{ enabled: false }`，要么同时提供 `level` 和 `project`。允许的级别固定为
`debug`、`info`、`warn` 和 `error`。禁用同样是一项显式策略，不能通过省略 `log` 获得。

`InformationKindRegistry` 在 Core 启动前接收定义。它按 kind 建立唯一映射，重复注册即使引用
同一个定义对象也会失败。启动时 Registry 被 seal；seal 后的注册全部拒绝。Core 的追加、读取
和发布均通过 Registry 解析 definition，因此数据库中出现当前进程未知的 kind 时，Core 必须
拒绝启动，而不是把 payload 降级为 `unknown`。

模块 manifest 声明自己提供的 kind。Runtime composition root 依次注册内置定义和所有启用模块
的定义，随后 seal Registry、连接数据库、执行迁移、核对数据库 kind，再创建订阅关系并开始
接收消息。模块若需要新增 kind，必须通过重启完成启动期注册，不能热注册。

## Relation 命名和语义

内置 relation 使用 `core:` 保留命名空间：

- `core:context` 表示原子属于某次运行上下文，用来替代 `traceId`。
- `core:caused-by` 指向直接促成当前事实的原子。
- `core:status-of` 让完成、失败、取消或失效原子指向其请求或起始原子。
- `core:supersedes` 让新事实声明自己替代一个旧事实，主要服务于 Memory 演进。
- `core:memory` 让召回事实引用一个或多个被召回的 Memory 原子。

自定义 relation 必须满足 `<namespace>:<name>` 形式，并且 namespace 不能是 `core`。relation
和 name 仅允许小写 ASCII 字母、数字、点、下划线及连字符，且必须以字母开头。自定义 relation
的语义由声明它的 kind 定义负责；Core 仍统一执行名称、数量、目标存在性和目标 kind 校验。

引用只能指向已提交原子。本次不提供一次追加中向未来原子建立引用的 batch API。相同
relation/target 组合在同一原子中只能出现一次；若 relation 规则声明 `multiple: false`，该
relation 最多出现一次。任何引用错误都会使整次追加回滚。

## 内置 kind 与信息流

Runtime 注册以下内置 kind：

- `core.runtime.context`
- `core.message.inbound.text`
- `core.message.assistant.text`
- `core.filter.decision`
- `core.run.started`
- `core.run.completed`
- `core.run.failed`
- `core.run.cancelled`
- `core.llm.requested`
- `core.llm.completed`
- `core.llm.failed`
- `core.delivery.requested`
- `core.delivery.delivered`
- `core.delivery.failed`
- `core.memory.stored`
- `core.memory.recalled`
- `core.memory.invalidated`
- `core.log.debug`
- `core.log.info`
- `core.log.warn`
- `core.log.error`

一条典型消息形成以下追加链：

```text
core.runtime.context
  └─ core.message.inbound.text
       └─ core.filter.decision
            └─ core.run.started
                 ├─ core.llm.requested
                 │    ├─ core.llm.failed
                 │    └─ core.llm.completed
                 │         └─ core.message.assistant.text
                 │              └─ core.delivery.requested
                 │                   └─ core.delivery.delivered | failed
                 └─ core.run.completed | failed | cancelled
```

每个下游事实用 `core:caused-by` 连接直接来源，并用 `core:context` 连接根运行上下文。终态用
`core:status-of` 指向对应的 started/requested 原子。查询一次运行的全部事实时，按
`core:context` 反向查找，不再依赖 `traceId`；重建因果链时沿 `core:caused-by` 查询。

现有可重写 `EventEnvelope` 的 interceptor 被移除。订阅者接收已提交的不可变原子；过滤器通过
追加 `core.filter.decision` 表达决定，模块通过 `context.append(...)` 产生新事实。执行控制可以
在调用栈中返回，但所有对外可观察的业务决定和状态必须同时由原子表达。一个订阅者失败不会
改变源原子；Runtime 捕获模块或节点失败后追加相应的 run/LLM/delivery failed 原子。

Memory 只建立契约。`core.memory.stored` 保存正文及 JSON attributes；更新时追加新的 stored
原子并以 `core:supersedes` 指向旧原子。`core.memory.recalled` 必须通过 `core:memory` 引用一个
或多个 stored 原子。`core.memory.invalidated` 必须通过 `core:status-of` 指向被失效的 stored
原子。Memory 查询和“当前有效版本”解析留给后续子系统。

## PostgreSQL 追加仓储

`@kaguya/database` 改用 `pg`，继续使用手写参数化 SQL，不引入 ORM。服务配置移除
`KAGUYA_DATABASE_PATH`，增加必填 `KAGUYA_DATABASE_URL`。`KaguyaDatabase.connect()`、
`migrate()`、所有仓储操作和 `close()` 都是异步接口。Runtime 可以注入 Pool-compatible
连接以支持隔离测试，但生产 composition root 只接受连接串，不把连接凭据写入日志。

数据库包含三个核心表：

```sql
CREATE TABLE information_kinds (
  kind text PRIMARY KEY,
  registered_at timestamptz NOT NULL
);

CREATE TABLE information_atoms (
  information_id text PRIMARY KEY,
  kind text NOT NULL REFERENCES information_kinds(kind),
  occurred_at timestamptz NOT NULL,
  source text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE information_references (
  information_id text NOT NULL REFERENCES information_atoms(information_id),
  position integer NOT NULL CHECK (position >= 0),
  relation text NOT NULL,
  target_information_id text NOT NULL REFERENCES information_atoms(information_id),
  PRIMARY KEY (information_id, position),
  UNIQUE (information_id, relation, target_information_id)
);
```

迁移还创建按 `kind, occurred_at, information_id` 和
`target_information_id, relation, information_id` 查询的索引。原子和引用表安装拒绝
`UPDATE` 与 `DELETE` 的触发器；外键不使用级联删除。应用仓储只公开 append/get/list 和关系
查询，不公开更新或删除方法。

启动时先在事务中 `INSERT ... ON CONFLICT DO NOTHING` 当前 Registry 的 kind，再比较数据库
kind 集合与 Registry。数据库存在而 Registry 缺失的 kind 会终止启动；Registry 新增的 kind
可以登记。数据库不持久化 Zod schema 或 projector，因为它们是可执行代码；历史 kind 的定义
必须继续随应用注册，payload schema 的不兼容变更应发布新 kind，而不是重解释旧原子。

## 追加事务与发布顺序

`InformationCore.append(definition, command)` 执行以下顺序：

1. 确认 definition 与 Registry 中的对象一致。
2. 严格解析时间、source、payload 和引用结构，检查 JSON compatibility。
3. 检查必需 relation、数量限制、重复项和 relation 命名。
4. 通过注入的生成器取得 `informationId`。
5. 开启 PostgreSQL 事务并插入 atom 行。
6. 一次读取所有引用目标，拒绝缺失目标和错误 target kind。
7. 插入 reference 行并提交。
8. 从已验证数据构造冻结原子，提交成功后才投递给订阅者和日志 projector。

引用目标不可更新或删除，因此校验后不会发生 kind 漂移。主键和外键仍是最终并发保护；ID
冲突映射为 `InformationIdConflictError`，引用竞态或数据库约束失败映射为带 cause 的引用或
仓储错误。任何提交前错误都回滚 atom 与全部 references。

发布沿用进程内订阅，订阅者以 `Promise.allSettled` 隔离。提交后的订阅失败不能回滚事实。
本次不增加持久化 outbox，因此进程在数据库提交与进程内发布之间崩溃时不会自动重放；这是
后续可靠队列设计的明确边界。

## 日志投影与正文截断

每个启用日志的 kind projector 返回安全消息和 JSON fields。logger 自动附加
`informationId`、`kind`、`occurredAt` 与 `source`，payload 不会被默认展开。现有 Pino
redaction 继续作为第二道保护，但 projector 本身必须只选择该 kind 的必要字段。

文本消息和系统日志必须提供必要正文：

- `core.message.inbound.text` 与 `core.message.assistant.text` 输出 `contentPreview`。
- `core.log.*` 输出 `message`。
- 预览最多保留前 168 个 Unicode code point；超出后追加 `…`。
- 同时输出 `contentLength` 和 `contentTruncated`，长度按 Unicode code point 计算。
- 换行保留，其他不安全控制字符转义后输出。

LLM prompt、原始模型响应、provider 凭据、数据库连接串、transport raw body 和 headers 不属于
必要正文，任何内置 projector 都不得输出这些值。日志字段名使用 `contentPreview`，避免把
明确允许的预览误交给现有通用 `content`/`text` redaction 路径。

普通生命周期原子直接通过自己的 kind 策略投影，不再额外创建“同一事实的日志记录”。只有
无法自然表达为业务或生命周期 kind 的运行诊断才追加 `core.log.*` 原子。这样文本消息与系统
日志由 kind 区分，但两者都只使用各自原子的 `informationId`。

projector 返回值必须再次通过 JSON compatibility 检查。projector 或控制台 stream 失败不会
回滚原子，也不会递归追加新的 log atom；logger 仅以直接应急路径输出原子 kind、
`informationId` 和错误类型。数据库尚未连接、迁移失败或 Core 尚未建立时，同样允许使用不含
连接串和 payload 的引导期应急日志。

## 错误模型

公共错误使用稳定 class 区分调用方错误和基础设施错误：

- `DuplicateInformationKindError`
- `InformationRegistrySealedError`
- `UnknownInformationKindError`
- `InvalidInformationPayloadError`
- `InvalidInformationReferenceError`
- `InformationIdConflictError`
- `InformationStoreError`

错误消息可以包含 kind、relation 或 opaque informationId，但不得包含完整 payload、消息正文、
prompt、响应、凭据或连接串。PostgreSQL driver 错误保留为 `cause` 供受控诊断，不把原始错误
对象直接序列化到业务日志。

## 包边界和迁移范围

`@kaguya/schema` 拥有原子、ID、引用和 JSON 值 schema。`@kaguya/sdk` 拥有
`defineInformationKind`、模块 kind 声明和追加上下文接口。`@kaguya/engine` 拥有 Registry、
Core、提交后发布和不可变快照。`@kaguya/database` 只拥有 PostgreSQL migration、行映射和
追加/查询实现。`@kaguya/runtime` 注册内置 kind 并把现有消息、过滤、LLM、运行和投递流程
组合为原子链。`@kaguya/logger` 提供投影执行、168 字符预览和 Pino 输出。

现有 `EventEnvelope`、`defineEvent`、EventBus 重写语义、各类记录 schema、SQLite repositories、
`databasePath` 配置和旧日志上下文 ID 随迁移删除。Prompt fragment 的 `id`、workflow/node/module
定义 ID 和外部平台 ID 只在其领域内保留；凡引用 Core 事实的字段都改为 `informationId` 或
带 relation 的 `InformationReference`。

## 验证策略

实现采用测试先行。每项行为先写能够因缺少该行为而失败的测试，再做最小实现并运行相关测试。

schema 单元测试覆盖严格字段、带时区时间、source、JSON object、引用数组和非法 JSON 值。
Registry 单元测试覆盖重复 kind、未知 kind、`core.*` 保留规则、seal 后注册以及缺失 schema/
日志策略。不可变性测试覆盖嵌套 object、array、payload 输入别名和数据库读取快照。

引用测试覆盖内置 relation、自定义 namespace、未声明 relation、必需 relation、单值/多值、
重复 relation-target、缺失目标和错误目标 kind，并验证失败事务不留下半个原子。ID 测试覆盖
默认 opaque 行为、确定性生成器、非法生成值、冲突拒绝以及追加命令不能携带 ID。

日志测试覆盖四个级别、禁用策略、projector 字段、投影失败隔离、正文 167/168/169 字符边界、
Unicode code point、换行与控制字符、`contentLength`、`contentTruncated`，并验证 prompt、响应、
凭据和 raw body 不会旁路泄漏。

PostgreSQL 测试覆盖迁移、kind 同步、JSONB、外键、事务回滚、并发追加、查询顺序和数据库触发器
拒绝更新/删除。日常测试使用 PostgreSQL-compatible 隔离实例；另提供由测试连接串启用的真实
PostgreSQL 集成测试入口，以验证 driver、DDL、trigger 和事务语义。

Runtime 集成测试验证完整的消息、过滤、run、LLM 和 delivery 原子链，以及 Memory kind 注册和
引用规则。最终门禁执行全仓库 Vitest、typecheck、lint、format check 和 build。

## 已知边界

统一身份和追加存储并不自动提供可靠消息队列。订阅重放、消费游标、幂等 handler、死信、数据
保留、归档和跨租户授权均不在本次范围。PostgreSQL 不保存可执行 schema，因此部署移除历史
插件前必须继续提供其 kind 定义，或先实施单独的归档策略。Memory 当前只有事实契约，不承诺
召回质量或“当前版本”查询性能。
