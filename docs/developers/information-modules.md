---
title: 信息模块协议与可靠消费
description: 用显式 Catalog、能力声明与 Information DAG 组合可检查的模块。
---

# 信息模块协议与可靠消费

模块通过不可变 Information Atom 协作。Catalog 声明哪些受信代码可用，activation 决定哪些实例启用以及各自的设置；新增文件不会自动取得执行权限。Server、Demo 的 composition root 显式导入 `createFirstPartyModuleCatalog()`，并把 Catalog、activations 与宿主 capabilities 传给 `KaguyaRuntime`。第三方 Catalog 必须同样显式 import，再通过 `mergeInformationModuleCatalogs()` 合并。

## 唯一模块协议

`defineInformationModule()` 的 manifest 必须包含 `protocolVersion: 1`、稳定 `definitionId`、语义版本 `moduleVersion`、`displayName`、`settingsSchema`，以及 `consumes`、`produces`、`selectors`、`promptRenderers`、`requires`、`provides` 六组声明。空声明使用空数组。重复 definition ID、不支持的协议、冲突的同名 kind、Selector 或 renderer 都会拒绝启动。

`consumes` 约束订阅输入，`produces` 约束派生输出。Selector 与 renderer 使用稳定 ID，并列入 manifest；`context.select()` 拒绝未声明的 Selector。订阅与声明必须引用同一份 kind definition，不能用结构相似的对象替代。Catalog 合并顺序不会改变创建顺序。

::: code-group

```ts [显式模块与 Catalog ~vscode-icons:file-type-typescript~]
const filter = defineInformationModule({
  manifest: {
    protocolVersion: 1,
    definitionId: "example.filter",
    moduleVersion: "1.0.0",
    displayName: "Example filter",
    settingsSchema: z.object({}).strict(),
    consumes: [inboundTextKind],
    produces: [replyRequestedKind],
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
            "example.filter.reply.v1",
            atom.informationId,
            replyRequestedKind,
            { payload: atom.payload },
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

activation 可设置 `enabled: false`，停用不会删除已持久化的未确认工作。kind 注册必须在 `Core.start()` 封闭 Registry 之前完成；自定义宿主可用 `catalogInformationKinds(catalog)` 收集精确的共享定义。Runtime 已执行这项装配。

## 能力与生命周期

`defineModuleCapability<T>("namespace:name", apiVersion)` 定义带类型的稳定 token。manifest 的 `requires` 与 `provides` 声明能力依赖；宿主或 provider 返回 `{ capability, value }` 实现。`context.use(token)` 只允许读取已声明且版本匹配的能力。业务模块之间仍通过原子推进阶段，能力承载受控基础设施服务。

Host 在任何 `create()` 前完成全部启用实例的 settings parse、深冻结、kind/Selector/renderer 校验与能力图检查；缺失、重复、版本不匹配或依赖环都立即失败。解析后的设置必须是普通 JSON 对象、数组或标量（可选字段允许 undefined）；Date、Map、Set、自定义实例和循环结构会在 create 前拒绝。随后按确定性拓扑顺序调用 `create(options, context)` 和 `instance.start(context)`，并核对 provisions 与清单精确一致。全部启动成功后才开放订阅，Runtime 最后开放 ingress。

`options` 包含只读 settings、instanceId 与 activation 来源身份。create、start、handler 的 context 均有 `AbortSignal`、`now()` 和受限 `use()`。启动失败按逆依赖顺序 stop、dispose，并聚合清理错误。正常停止先拒绝新入口和领取，传播 abort、逆序 stop、有界排空 live handlers，再逆序 dispose。迟到 handler 不能在停用后提交输出。`drainTimeoutMs` 控制 Runtime、Core 和 Host 各关闭阶段的等待上限，默认 5000 毫秒；stop/dispose 钩子超时会记录为清理失败，并继续清理剩余模块。创建失败时同样会取消该实例的 signal。生命周期顺序不表示业务 DAG 顺序。

`host.inspect()` 从 Catalog 与实际绑定生成 definition/module/protocol 版本、settings schema 的 SHA-256 指纹、kind、Selector/renderer ID 和 capability bindings。它不输出 settings 值、URL、凭据、Prompt、人物或记忆正文。

## 可靠派生与终态

`delivery: "durable"` 的业务订阅使用持久化 delivery、租约 claim、有限重试和 token fencing。订阅只接收登记后的新事实；输入原子与匹配 delivery intent 同事务提交。相同 activation 与 subscription 身份重启后可恢复未确认工作。普通 `live` 订阅用于即时观察，不提供离线恢复。

`context.registerOnce(operation, key, definition, input)` 为逻辑输出使用唯一槽，并返回实际赢家。`context.commitTerminal(group, subjectInformationId, definition, input)` 为同一主体竞争一个跨 kind 的终态，因此返回类型允许不同终态 kind。操作键必须来自稳定业务输入；实例 ID 只标识投递接收方。演示回复以输入 ID 与设置哈希区分语义任务，相同设置的重复实例会复用同一结果。

宿主为输出补齐 `module:<instanceId>` source、时间、指向输入的 `core:caused-by` 及继承的 `core:context`。调用方不能覆盖这些保留引用。durable handler 不得用普通 `register()` 绕过去重；其嵌套生命周期写入也受当前 claim 保护。重试耗尽会产生 `execution.exhausted` 可见事实，健康检查只返回 pending、retry、exhausted 与最老 pending 年龄。

Runtime 的 `submit()` 返回已接受输入的根 ID；可靠回复异步推进，返回时 `deliveries` 通常为空。调用方应通过账本观察终态。外部模型和平台副作用仍是 at-least-once：进程可能在外部动作完成、账本终态提交之前崩溃。

## 显式上下文与 Prompt

Selector 通过受限只读账本的 `find()`、`related()`、`retrieve()` 取得候选，只返回有序 informationId。Core 校验 ID、拒绝重复或越权结果，并按顺序重新加载冻结原子。模块不能把未落账 payload 拼成上下文。

默认 reply Selector 只选择当前 `core.reply.requested`。额外 Memory 必须由自定义 Selector 显式选择。reply 和 Memory 的 renderer 在 manifest 中声明；每个 Prompt fragment 保留 informationId，LLM requested 使用同序 `core:uses-context` 引用追溯输入。未知 kind 不会被静默当作文本注入。这里不引入隐式会话桶、历史自动回填或新的 Model Task 抽象。
