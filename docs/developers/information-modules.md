---
title: 信息模块协议与可靠消费
description: 用显式 Catalog、能力声明与 Information DAG 组合可检查的模块。
---

# 信息模块协议与可靠消费

模块通过不可变 Information Atom 协作。Catalog 声明哪些受信代码可用，activation 决定哪些实例启用以及各自的设置；新增文件不会自动取得执行权限。Server 与 Demo 共用 `@kaguya/composition` 的 `createMessageComposition()`，由它调用唯一的一方 Catalog 与 activation 工厂，并把 Catalog、activations 与宿主 capabilities 传给 `KaguyaRuntime`。第三方 Catalog 必须同样显式 import，再通过 `mergeInformationModuleCatalogs()` 合并。

## 唯一模块协议

`defineInformationModule()` 的 manifest 必须包含 `protocolVersion: 1`、稳定 `definitionId`、语义版本 `moduleVersion`、非空 `displayName`、单行 `summary`、完整 `description`、`settingsSchema`，以及 `consumes`、`produces`、`selectors`、`promptRenderers`、`requires`、`provides` 六组声明。每个模块目录还必须携带相邻 `README.md`。Runtime 不读取 Markdown。协议只接受当前 v1，其他版本直接失败。

`consumes` 约束订阅输入，`produces` 约束派生输出。Selector 与 renderer 使用稳定 ID，并列入 manifest；`context.select()` 拒绝未声明的 Selector。订阅与声明必须引用同一份 kind definition，不能用结构相似的对象替代。Catalog 合并顺序不会改变创建顺序。

::: code-group

```ts [显式模块与 Catalog ~vscode-icons:file-type-typescript~]
const filter = defineInformationModule({
  manifest: {
    protocolVersion: 1,
    definitionId: "example.filter",
    moduleVersion: "1.0.0",
    displayName: "Example filter",
    summary: "Filters inbound text before downstream processing.",
    description: "Records an explicit filter decision for inbound text.",
    settingsSchema: z.object({}).strict(),
    consumes: [inboundTextKind],
    produces: [filterDecisionKind],
    selectors: [],
    promptRenderers: [],
    requires: [],
    provides: [],
  },
  create: () => ({
    provisions: [],
    subscriptions: [
      onInformation(
        inboundTextKind,
        { subscriptionId: "example.filter.inbound", delivery: "durable" },
        async (atom, context) => {
          await context.registerOnce(
            "example.filter.decision.v1",
            atom.informationId,
            filterDecisionKind,
            {
              payload: {
                accepted: false,
                reason: "example",
                filterDefinitionId: "example.filter",
              },
            },
          );
        },
      ),
    ],
  }),
});

const catalog = defineInformationModuleCatalog(filter);
const activations = [
  { instanceId: "filter.main", definitionId: "example.filter", settings: {} },
];
```

:::

每个实例配置位于 `<KAGUYA_CONFIG_ROOT>/modules/<instanceId>/config.json`，严格包含 `version: 1`、`instanceId`、`definitionId`、`enabled` 和完整 `settings`。仅当整个 `modules/` 不存在时，Server 才写入六个一方实例模板；目录一旦存在，缺文件、未知实例、身份不符、版本错误或缺少 settings 字段都会阻止启动且不会被修复。修改文件后必须重启。`enabled: false` 的有效实例不激活，但 settings 仍需通过完整 schema 校验。

仓库内的一方模块使用 `packages/modules/src/first-party/<module>/index.ts`，测试与模块放在同一目录。共用 Kind 放在 `src/first-party/information-kinds.ts`，Catalog 固定放在 `src/first-party/catalog.ts`。Catalog 必须显式 import 并注册每个受信模块；Runtime 禁止扫描目录或根据文件名自动发现模块。新增文件若未进入 Catalog，就不会注册、激活或取得执行权限。包根 `src/index.ts` 继续提供稳定公共导出，调用方不依赖一方模块内部路径。

`consumes` 与 `produces` 是模块 Kind 的唯一接口。Runtime 从 Catalog 中各 Manifest 的这两个字段收集定义，只单独注册 Runtime、Engine 与 Scheduler 自身拥有的基础 Kind。不要维护第二份模块 Kind 总表。

## 能力与生命周期

`defineModuleCapability<T>("namespace:name", apiVersion)` 定义带类型的稳定 token。manifest 的 `requires` 与 `provides` 声明能力依赖；宿主或 provider 返回 `{ capability, value }` 实现。`context.use(token)` 只允许读取已声明且版本匹配的能力。业务模块之间仍通过原子推进阶段，能力承载受控基础设施服务。

Host 在任何 `create()` 前完成全部启用实例的 settings parse、深冻结、kind/Selector/renderer 校验与能力图检查；缺失、重复、版本不匹配或依赖环都立即失败。解析后的设置必须是普通 JSON 对象、数组或标量（可选字段允许 undefined）；Date、Map、Set、自定义实例和循环结构会在 create 前拒绝。随后按确定性拓扑顺序调用 `create(options, context)` 和 `instance.start(context)`，并核对 provisions 与清单精确一致。全部启动成功后才开放订阅，Runtime 最后开放 ingress。

`options` 包含只读 settings、instanceId 与 activation 来源身份。create、start、handler 的 context 均有 `AbortSignal`、`now()`、受限 `use()` 和声明式 `report()`。启动失败按逆依赖顺序 stop、dispose，并聚合清理错误。正常停止先拒绝新入口和领取，传播 abort、逆序 stop、有界排空 live handlers，再逆序 dispose。迟到 handler 不能在停用后提交输出。`drainTimeoutMs` 控制 Runtime、Core 和 Host 各关闭阶段的等待上限，默认 5000 毫秒；stop/dispose 钩子超时会记录为清理失败，并继续清理剩余模块。创建失败时同样会取消该实例的 signal。生命周期顺序不表示业务 DAG 顺序。

`defineModuleDiagnostic()` 固定 event、消息、级别、严格 payload schema 和安全投影；definition 必须列入当前 manifest，才能传给 `context.report()`。模块还可用 `describeStartup()` 返回一句启动状态和少量安全字段。Host 的 started/failed 是权威生命周期，模块描述和瞬时诊断都是补充信息；详见 [Runtime 与 Information 可观测性](./observability)。

`host.inspect()` 从 Catalog 与实际绑定生成 definition/module/protocol 版本、模块名称与说明、settings schema 的 SHA-256 指纹、输入输出 Kind 的 ID/名称/说明、Selector ID、renderer 的 ID/名称/说明/适用 Kind，以及 capability bindings。它不输出 settings 值、URL、凭据、Prompt、人物或记忆正文。Inspection API 与 WebUI 必须直接使用 Manifest 的展示字段，不能维护模块或 Kind 名称映射。

## 可靠派生与终态

`delivery: "durable"` 的业务订阅使用持久化 delivery、租约 claim、有限重试和 token fencing。订阅只接收登记后的新事实；输入原子与匹配 delivery intent 同事务提交。相同 activation 与 subscription 身份重启后可恢复未确认工作。普通 `live` 订阅用于即时观察，不提供离线恢复。

`context.registerOnce(operation, key, definition, input)` 为逻辑输出使用唯一槽，并返回实际赢家。`context.commitTerminal(group, subjectInformationId, definition, input)` 为同一主体竞争一个跨 kind 的终态，因此返回类型允许不同终态 kind。操作键必须来自稳定业务输入；实例 ID 只标识投递接收方。演示回复以输入 ID 与设置哈希区分语义任务，相同设置的重复实例会复用同一结果。

宿主为输出补齐 `module:<instanceId>` source、时间、指向输入的 `core:caused-by` 及继承的 `core:context`。调用方不能覆盖这些保留引用。durable handler 不得用普通 `register()` 绕过去重；其嵌套生命周期写入也受当前 claim 保护。重试耗尽会产生 `execution.exhausted` 可见事实，健康检查只返回 pending、retry、exhausted 与最老 pending 年龄。

Runtime 的 `submit()` 返回已接受输入的根 ID；可靠回复异步推进，返回时 `deliveries` 通常为空。调用方应通过账本观察终态。外部模型和平台副作用仍是 at-least-once：进程可能在外部动作完成、账本终态提交之前崩溃。

## Durable One-Shot 能力

需要等待、去抖或延迟一次处理的模块可以声明 `kaguya:schedule.one-shot@1`，并把输入身份放在 opaque JSON `input` 中。模块负责决定何时调用 `replace()` 合并输入、如何读取 requested atom，以及在 due consumer 中调用 `finish()`。调度器只负责绝对时间、恢复和唯一终态；它不会启动 Heartbeat、Heartflow、Attention Arousal 或 Model Task，也不会解释模块输入。

## 显式上下文与 Prompt

Selector 通过受限只读账本的 `find()`、`related()`、`retrieve()` 取得候选，只返回有序 informationId。`find()` 支持 JSON payload containment 和确定性的正序/倒序查询。Core 校验 ID、拒绝重复或越权结果，并按顺序重新加载冻结原子。模块不能把未落账 payload 拼成上下文。派生输出通常继承输入的 `core:context`；需要跨入站合并时，可用 `contextInformationId` 重定位，但目标必须是该 handler 已通过声明式 Selector 选出的 `core.runtime.context`。

首次生成的模块配置显式启用 Identity、durable Heartbeat、Heartflow、Attention Arousal、Association 与 Message Composer，并把 Heartbeat、Heartflow 和注意力参数完整写入文件。Runtime 拥有的 Model Task 失败/取消、delivery terminal 与 `execution.exhausted` definition 由 composition root 注入 Heartflow，Catalog 不复制这些 kind。

Heartbeat 到期只产生 `agent.turn.candidate`。Heartflow 使用 scope generation 领取 candidate，等待全部 inbound 的 identity terminal，再按 `asOf` 冻结不可变的多输入 `agent.turn.context.completed`。Attention Arousal 只提交 claim 的唯一 `attend | defer | ignore` 决策；Heartflow 仅在 attend 后执行独立的 `agent.turn.plan` v1，并按 `agent.turn.plan.completed` 的 `message | wait | silent` 分派为 message intent、wait 或 silent，并在 delivery、等待、静默、supersession 或耗尽时写入一个 turn terminal。默认 Catalog 不包含 always-reply 或 inbound-to-context 旁路。

`createMessageComposerModule()` 默认直接消费 Heartflow 产生的 `agent.message.intent.requested`，并通过 message intent 的 `core:uses-context` 找到冻结 turn context。Memory 默认由 selected Profile 关闭；此时 Heartflow 的可选检索退化为空，Prompt 仍包含当前冻结输入。Association 继续记录 requested、query、candidate 和 completed 审计 DAG，但不再作为 Message Composer 的门禁。

显式开启 `memory.enabled` 后，关联检索才以冻结 turn 的全部输入按顺序组成 query 执行全局召回，最多选择 8 条不晚于当前请求、且排除当前 turn 全部输入的结果。身份结果仍写入审计元数据，但不缩小默认召回范围，Web 和 ephemeral 消息同样进入这条链。Runtime 的命名检索策略只返回来源 ID，Core 随后从追加式账本重新加载并授权原始 inbound atom，因此 candidate 和 Prompt provenance 都直接指向不可变消息，而不是临时 Memory atom。

Memory 变量在完整当前 turn 之前，合计最多 4,000 个 Unicode 字符；召回失败会退化为空内容，不阻塞当前回复。message intent、历史 `core.memory.text` 和原始 inbound 的 renderer 都在 manifest 中声明，每个模板变量保留其 informationIds，LLM requested 使用 `core:uses-context` 引用追溯实际输入。一个原子可同时支持多个变量，一个变量也可聚合多个原子。未知 kind 不会被静默当作文本注入。scope、claim、上下文和终态都由 Information DAG 表达，不引入进程内 Session 或可变对话桶。

一方 Prompt 最终文本由 `packages/modules/templates/*.default.hbs` 的受限 Handlebars 层级排版。开发者可复制为同名 `*.local.hbs` 做本地覆盖；local 文件被 Git 忽略，重启后生效。声明变量可出现零次或多次，只有外层实际使用的逻辑变量进入 provenance；未知变量、动态或递归 partial 和非内建 helper 会在启动时失败。替换不做 XML/HTML 逃逸或额外包裹，数据边界由模板作者负责。

## Message Intent 与 Composer

必要性门控通过且 Planner 判定 message 后，Heartflow 为一个冻结 turn 确定性创建一次 `agent.message.intent.requested`。其严格 payload 包含 `target: { adapterId, platform, destination }`、`turn: { candidateInformationId, claimInformationId, contextInformationId }` 与 `memoryInformationIds`。`target` 取自冻结 turn 的最新入站来源；意图本身不复制源正文、源平台消息 ID、发送者信息或引用标记。

默认 `agent.message-composer` 模块由 `message-composer.default` 实例激活，执行 `agent.message.compose` Model Task，使用 `message` Prompt kind。Composer 通过引用重载完整冻结 turn，把其中所有输入作为当前回合共同呈现；最后一条输入没有必须回答的特殊地位。历史与 Memory 分别受预算限制，当前冻结输入不因历史预算被剔除。入站引用只帮助理解上下文，默认出站内容始终为 `kind: "text"`。

旧 reply 信息原子不会迁移或由新模块处理，旧 Prompt kind 和 Model Task ID 不再属于当前协议。旧模块配置须备份后重新初始化，不能仅重命名旧文件来保留旧 outbound 设置。公共 `OutboundMessageContent.kind: "reply"` 与 OneBot 显式引用能力继续保留，供专用模块主动构造。

Planner 已支持 `message | wait | silent`；跨会话目标检索仍属于后续工作。Planner 由现有 Heartflow 实例装配，默认 light tier，无需新增 speech 实例或 Profile/API/WebUI 配置。首次请求冻结 Prompt 与上下文选择，重放复用已持久化任务；wait 为 5–120 秒并复用三次总预算与 durable heartbeat，失败和取消统一以 `planner-unavailable` 静默结束。普通日志不记录 Planner Prompt 预览或原始模型输出。
