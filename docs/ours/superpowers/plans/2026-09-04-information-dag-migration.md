# Information DAG Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Kaguya 的入站、过滤、LLM、回复与投递路径一次性切换为持久化优先的信息原子 DAG，并删除旧事件身份和模块级 Profile 回退。

**Architecture:** `InformationCore.register()` 是唯一原子写入入口，先校验并提交 PostgreSQL 账本，再向当前同 kind 消费者并发广播。Gateway 与平台 adapter 只依赖窄 `InformationIngress`；模块通过 `onInformation` 消费原子并用 `context.register()` 显式产生带因果引用的下一阶段原子，消费者失败则追加 `consumer.failed`。

**Tech Stack:** TypeScript 6、Node.js 24、pnpm workspace、Vitest、Zod、PostgreSQL/pg、PGlite、Fastify。

**Spec:** `docs/ours/superpowers/specs/2026-09-04-information-dag-migration-design.md`

## Global Constraints

- Core 身份只能是 `informationId`；不得保留 event ID、message ID、trace ID 或 Event 到 Atom 包装层。
- 所有原子必须先持久化，后广播；持久化失败不得广播。
- 同 kind 当前消费者独立并发，Core 不提供排序、优先级、拦截、短路或定向派发。
- 无订阅者时原子仍持久化；不实现持久订阅、补投、队列或自动重试。
- 过滤通过时显式注册下一 kind；拒绝时只注册 `filter.decision`。
- 消费失败追加 `consumer.failed`，不回滚输入、不妨碍其他消费者、不自动重试。
- Runtime 启动时只使用全局 `selectedProfileId`；模块 settings、消息和信息原子不携带 `profileId`。
- 所有本次新建或修改的源码文件均维护准确的中文头部注释；JSON、锁文件和生成物不添加伪注释。
- 每项行为变更严格遵循 RED → GREEN → REFACTOR；未观察到预期失败之前不写生产实现。

## 文件结构与职责

- `packages/engine/src/information-core.ts`：唯一注册、读取、订阅和消费者失败编排边界。
- `packages/engine/src/information-bus.ts`：取得订阅者快照并并发执行，不吞掉结构化执行结果。
- `packages/engine/src/information-kinds.ts`：Engine 自有的 `consumer.failed` kind。
- `packages/sdk/src/information-kind.ts`：公开注册输入类型与 kind definition。
- `packages/sdk/src/information-modules.ts`：`onInformation`、ModuleDefinition 和 handler context 契约。
- `packages/engine/src/information-module-host.ts`：把模块订阅接入 Core，并派生模块身份与因果引用。
- `packages/modules/src/information-kinds.ts`：入站、过滤、回复和投递业务 kind。
- `packages/modules/src/always-reply-information-filter.ts`：通过时产生回复请求的默认过滤模块。
- `packages/modules/src/llm-information-reply.ts`：消费回复请求并产生 assistant 文本与投递请求。
- `packages/runtime/src/information-kinds.ts`：Runtime context、LLM 和投递结果 kind 聚合。
- `packages/runtime/src/llm-lifecycle.ts`：把 LLM 调用结果注册为原子。
- `packages/runtime/src/runtime.ts`：组合 Core、PostgreSQL、模块和 transport，并实现 ingress。
- `packages/platform-adapters/src/types.ts`：无 Core 身份字段的平台输入与窄 ingress 类型。
- `apps/server/src/web-gateway.ts`、`apps/server/src/napcat.ts`：只向 ingress 提交内容。
- `scripts/information-architecture.test.ts`：检查旧身份与旧事件公共符号已经删除。

### Task 1: 收敛 Core 的注册、并发广播与故障事实

**Files:**

- Modify: `packages/sdk/src/information-kind.ts`
- Modify: `packages/sdk/src/information-kind.test.ts`
- Modify: `packages/engine/src/information-bus.ts`
- Modify: `packages/engine/src/information-bus.test.ts`
- Create: `packages/engine/src/information-kinds.ts`
- Modify: `packages/engine/src/information-core.ts`
- Modify: `packages/engine/src/information-core.test.ts`
- Modify: `packages/engine/src/index.ts`

**Interfaces:**

- Produces: `InformationRegistrationInput<K, P>`，不含 `informationId` 与重复的 `kind`。
- Produces: `InformationCore.register(definition, input)` 与 `InformationCore.on(definition, consumer, handler)`。
- Produces: `consumerFailedInformationKind`，字面 kind 为 `consumer.failed`。
- Removes later: `append`、string-only `subscribe`、`InformationBusOptions.onSubscriberError`。

- [ ] **Step 1: 写 Core RED 测试**

在 `information-core.test.ts` 增加真实内存 ledger 测试。并发测试用两个 deferred barrier 证明两个 handler 都已开始，之后才释放：

```ts
it("starts every current consumer concurrently after commit", async () => {
  const started: string[] = [];
  const release = deferred<void>();
  core.on(inputKind, { consumerId: "first" }, async () => {
    started.push("first");
    await release.promise;
  });
  core.on(inputKind, { consumerId: "second" }, async () => {
    started.push("second");
    await release.promise;
  });

  const registering = core.register(inputKind, registration({ text: "月" }));
  await vi.waitFor(() => expect(new Set(started)).toEqual(new Set(["first", "second"])));
  expect(ledger.operations.slice(0, 1)).toEqual(["append:atom-1"]);
  release.resolve();
  await registering;
});
```

同一文件继续增加以下独立测试：无消费者仍可 `get()`；提交失败时 handler 未执行；订阅后不补投历史原子；一个 handler 失败而另一个成功；失败只产生一条 `consumer.failed`；失败消费者只调用一次；消费 `consumer.failed` 再失败不会递归；失败原子无法提交时只调用 bootstrap reporter。

- [ ] **Step 2: 运行 Core 测试并确认 RED**

Run:

```bash
pnpm vitest run packages/engine/src/information-bus.test.ts packages/engine/src/information-core.test.ts
```

Expected: FAIL，原因是 `register`、带 consumer identity 的 `on` 和 `consumer.failed` 尚不存在，而不是 fixture 或导入错误。

- [ ] **Step 3: 实现最小注册与广播语义**

将公开输入收敛为：

```ts
export type InformationRegistrationInput<K extends string, P extends JsonObject> = {
  readonly occurredAt: string;
  readonly source: string;
  readonly payload: P;
  readonly references: readonly InformationReference[];
};

export interface InformationConsumer {
  readonly consumerId: string;
  readonly definitionId?: string;
  readonly instanceId?: string;
}
```

`InformationBus.publish()` 返回每个 subscriber 的 `{ consumer, status, reason? }`，调用仍用同一个 `Promise.allSettled`。`InformationCore.register()` 在 ledger append 成功后发布，并对 rejected 结果调用内部 `recordConsumerFailure()`。该内部路径注册 `consumer.failed` 时设置递归保护；错误摘要只包含稳定的 `errorType` 与 `message`，不保存 stack 或原始对象。

- [ ] **Step 4: 运行聚焦测试与包类型检查并确认 GREEN**

Run:

```bash
pnpm vitest run packages/sdk/src/information-kind.test.ts packages/engine/src/information-bus.test.ts packages/engine/src/information-core.test.ts
pnpm --filter @kaguya/sdk typecheck
pnpm --filter @kaguya/engine typecheck
```

Expected: 全部 PASS，无未处理 rejection。

- [ ] **Step 5: 提交 Core 切片**

```bash
git add packages/sdk/src/information-kind.ts packages/sdk/src/information-kind.test.ts packages/engine/src
git commit -m "refactor(core): register and broadcast information atoms"
```

### Task 2: 将模块 SDK 固定为 onInformation 与 context.register

**Files:**

- Modify: `packages/sdk/src/information-modules.ts`
- Modify: `packages/sdk/src/information-modules.test.ts`
- Modify: `packages/sdk/src/index.ts`
- Modify: `packages/engine/src/information-module-host.ts`
- Modify: `packages/engine/src/information-module-host.test.ts`
- Modify: `packages/engine/src/index.ts`

**Interfaces:**

- Consumes: Task 1 的 `InformationCore.on/register`。
- Produces: `onInformation(definition, handler)`。
- Produces: `InformationModuleHandlerContext.register(definition, { payload, references? })`。
- Removes: `append`、`onTargetedInformation`、`targeted`、ModuleHost 的目标实例选择和独立 run-lifecycle 回调。

- [ ] **Step 1: 写 SDK 与 ModuleHost RED 测试**

将 SDK 合约测试改成只允许非定向订阅，并在宿主测试中直接断言派生引用：

```ts
it("registers a derived atom with module identity and causal references", async () => {
  const derived: InformationAtom[] = [];
  const module = defineInformationModule({
    manifest: manifest([inputKind, outputKind]),
    create: () => ({
      subscriptions: [
        onInformation(inputKind, async (atom, context) => {
          derived.push(await context.register(outputKind, {
            payload: { text: atom.payload.text },
          }));
        }),
      ],
    }),
  });

  await startHost(module, core);
  await core.register(inputKind, registration({ text: "moon" }));
  expect(derived[0]?.source).toBe("module:echo.default");
  expect(derived[0]?.references).toContainEqual({
    relation: "core:caused-by",
    informationId: "atom-input",
  });
});
```

增加测试：继承唯一 `core:context`；拒绝调用方提供保留 relation；拒绝未在 manifest 声明的输出 kind；输入 atom 深冻结；同 kind 的两个模块实例均收到原子；不存在 `onTargetedInformation` 导出。

- [ ] **Step 2: 运行模块宿主测试并确认 RED**

```bash
pnpm vitest run packages/sdk/src/information-modules.test.ts packages/engine/src/information-module-host.test.ts
```

Expected: FAIL，显示当前接口仍叫 `append` 且保留 targeted subscription。

- [ ] **Step 3: 实现最终 SDK 与宿主**

handler context 使用以下签名：

```ts
register<K extends string, P extends JsonObject>(
  definition: InformationKindDefinition<K, P>,
  input: {
    readonly payload: P;
    readonly references?: readonly InformationReference[];
  },
): Promise<DeepReadonly<InformationAtom<K, P>>>;
```

ModuleHost 为每个订阅传入 `{ consumerId: `module:${instanceId}`, definitionId, instanceId }`，让 Core 统一记录 `consumer.failed`。删除 `targetOf()`、target grouping、`InformationModuleTargetNotFoundError` 和 `InformationModuleRunLifecycle`；模块执行失败不得再次由宿主抛回广播调用方。

- [ ] **Step 4: 运行聚焦测试和全局 typecheck**

```bash
pnpm vitest run packages/sdk/src/information-modules.test.ts packages/engine/src/information-module-host.test.ts
pnpm --filter @kaguya/sdk typecheck
pnpm --filter @kaguya/engine typecheck
pnpm typecheck
```

Expected: 全部 PASS。

- [ ] **Step 5: 提交模块 SDK 切片**

```bash
git add packages/sdk/src packages/engine/src
git commit -m "refactor(sdk): register derived information atoms"
```

### Task 3: 用显式 kind 重建过滤与回复模块

**Files:**

- Modify: `packages/modules/src/information-kinds.ts`
- Modify: `packages/modules/src/always-reply-information-filter.ts`
- Create: `packages/modules/src/llm-information-reply.ts`
- Modify: `packages/modules/src/information-modules.test.ts`
- Modify: `packages/modules/src/index.ts`

**Interfaces:**

- Produces: `core.message.inbound.text`、`core.reply.requested`、`filter.decision`、`core.message.assistant.text`、`core.delivery.requested`。
- Produces: 默认过滤模块；通过时产生 `core.reply.requested`，拒绝模块 fixture 只产生 `filter.decision`。
- Produces: `createLlmInformationReplyModule`，消费回复请求并注册 assistant 与 delivery 原子。
- Removes: `shouldReply: true` 驱动下一阶段、`targetInstanceId` 和模块 settings 中的 reply target。

- [ ] **Step 1: 写过滤与派生 DAG RED 测试**

```ts
it("registers the next kind when the filter passes", async () => {
  await dispatchInbound(core, "hello");
  expect(await kindsInLedger()).toEqual([
    "core.runtime.context",
    "core.message.inbound.text",
    "core.reply.requested",
  ]);
  expect(await atomsOfKind("filter.decision")).toEqual([]);
});

it("records rejection without producing the next kind", async () => {
  await dispatchInboundWith(rejectingFilter, core, "blocked");
  expect(await atomsOfKind("filter.decision")).toHaveLength(1);
  expect(await atomsOfKind("core.reply.requested")).toEqual([]);
});
```

增加派生测试：reply requested 指向 inbound；assistant 指向 LLM completed；delivery requested 指向 assistant；所有原子继承同一 context；settings schema 对 `profileId`、`replyTargetInstanceId` 使用 strict rejection。

- [ ] **Step 2: 运行模块测试并确认 RED**

```bash
pnpm vitest run packages/modules/src/information-modules.test.ts
```

Expected: FAIL，因为当前过滤模块产生 `core.filter.decision` 成功值且依赖 target instance。

- [ ] **Step 3: 实现 kind 与模块的最小 DAG**

`filter.decision` payload 固定为拒绝事实：

```ts
const filterDecisionPayloadSchema = z.object({
  accepted: z.literal(false),
  reason: z.string().trim().min(1),
  filterDefinitionId: z.string().trim().min(1),
}).strict();
```

默认 always-reply filter 的空 settings schema 订阅 inbound 并注册 reply requested。LLM reply 模块只接收 `{ modelTier, outbound }`；它通过注入的 executor 获取 LLM completed atom 与输出，再注册 assistant 和 delivery requested。

- [ ] **Step 4: 验证模块测试与类型**

```bash
pnpm vitest run packages/modules/src/information-modules.test.ts
pnpm --filter @kaguya/modules typecheck
```

Expected: PASS。

- [ ] **Step 5: 提交业务模块切片**

```bash
git add packages/modules/src
git commit -m "refactor(modules): express filtering as information kinds"
```

### Task 4: 围绕 PostgreSQL 信息账本重组 Runtime

**Files:**

- Modify: `packages/llm/src/client.ts`
- Modify: `packages/llm/src/index.test.ts`
- Create: `packages/runtime/src/information-kinds.ts`
- Create: `packages/runtime/src/information-kinds.test.ts`
- Replace: `packages/runtime/src/llm-lifecycle.ts`
- Replace: `packages/runtime/src/llm-lifecycle.test.ts`
- Replace: `packages/runtime/src/runtime.ts`
- Replace: `packages/runtime/src/runtime.test.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify: `packages/database/src/index.ts`
- Modify: `packages/database/src/testing.ts`

**Interfaces:**

- Produces: `builtInInformationKinds`，包含 context、consumer failure、消息、过滤、LLM 与投递 kinds，且无重复定义。
- Produces: `KaguyaRuntime` 实现 `InformationIngress.submit(input)`。
- Produces: `KaguyaRuntimeOptions` 的 `{ databaseUrl } | { database }` 判别联合。
- Produces: `RuntimeDispatchResult.rootInformationId` 与基于当前调用观察到的 delivery receipts。
- Removes: Runtime 对 SQLite message/eventRun/llmTrace/outbound repository 的写入。

- [ ] **Step 1: 写 LLM 生命周期 RED 测试**

使用真实 PGlite testing database 和确定性模型断言：

```ts
expect(observed.map((atom) => atom.kind)).toEqual([
  "core.llm.requested",
  "core.llm.completed",
]);
expect(observed[1]?.references).toContainEqual({
  relation: "core:status-of",
  informationId: observed[0]?.informationId,
});
```

失败路径必须注册 `core.llm.failed` 后重新抛出分类后的 `KaguyaLlmError`；日志 projector 不得输出 prompt、response、credential 或 database URL。

- [ ] **Step 2: 写 Runtime 端到端 RED 测试**

覆盖 Web 输入完整链：

```ts
const result = await runtime.submit(webMessage("hello"));
const graph = await database.information.query({
  informationId: result.rootInformationId,
});
expect(new Set(graph.map(({ kind }) => kind))).toEqual(new Set([
  "core.message.inbound.text",
  "core.reply.requested",
  "core.llm.requested",
  "core.llm.completed",
  "core.message.assistant.text",
  "core.delivery.requested",
  "core.delivery.delivered",
]));
```

另测：transport missing、transport reject、平台返回失败 receipt、无订阅 kind、两个 reply 消费者并发、关闭时等待 in-flight、关闭后拒绝 ingress、消费者故障仍保留其他结果。

- [ ] **Step 3: 运行 Runtime 测试并确认 RED**

```bash
pnpm vitest run packages/llm/src/index.test.ts packages/runtime/src/information-kinds.test.ts packages/runtime/src/llm-lifecycle.test.ts packages/runtime/src/runtime.test.ts
```

Expected: FAIL，因为 Runtime 仍构造 `EventBus`、SQLite 和旧 repositories。

- [ ] **Step 4: 实现低层 LLM 无持久化调用与原子生命周期**

低层 client 只返回：

```ts
export interface KaguyaLlmGeneration<T> {
  readonly output: T;
  readonly usage?: Record<string, number>;
  readonly durationMs: number;
}
```

Runtime 的 lifecycle wrapper 在调用前注册 requested，成功后注册 completed，失败后注册 failed。生命周期原子的持久化由 Core 完成，低层 LLM client 不再接收 trace writer。

- [ ] **Step 5: 实现 Runtime composition 和 delivery consumer**

Runtime start 的最小顺序为：连接或接收 `PostgresKaguyaDatabase`、迁移、注册所有 kind、构造 Core、启动 Core、启动 ModuleHost、注册系统 delivery consumer、开放 ingress。系统 consumer identity 固定为 `runtime:delivery`。

投递请求 handler 调用 transport 后注册：

```ts
await context.register(
  receipt.ok ? deliveryDeliveredKind : deliveryFailedKind,
  { payload: safeDeliveryPayload(receipt) },
);
```

不得同时写旧 `outboundMessages` 表。Runtime result 只能使用根 `informationId` 和外部 receipt，不制造 trace ID 或 message ID。

- [ ] **Step 6: 验证 Runtime 切片**

```bash
pnpm vitest run packages/llm/src/index.test.ts packages/runtime/src/information-kinds.test.ts packages/runtime/src/llm-lifecycle.test.ts packages/runtime/src/runtime.test.ts
pnpm --filter @kaguya/llm typecheck
pnpm --filter @kaguya/runtime typecheck
```

Expected: PASS。

- [ ] **Step 7: 提交 Runtime 切片**

```bash
git add packages/llm/src packages/runtime/src packages/database/src/index.ts packages/database/src/testing.ts
git commit -m "refactor(runtime): run the persisted information DAG"
```

### Task 5: 将 Web、NapCat 与 Server 收窄到 Core ingress

**Files:**

- Modify: `packages/platform-adapters/src/types.ts`
- Modify: `packages/platform-adapters/src/onebot.ts`
- Modify: `packages/platform-adapters/src/onebot.test.ts`
- Modify: `packages/platform-adapters/src/napcat.ts`
- Modify: `packages/platform-adapters/src/napcat.test.ts`
- Modify: `packages/platform-adapters/src/web.ts`
- Modify: `packages/platform-adapters/src/web.test.ts`
- Modify: `packages/platform-adapters/src/index.ts`
- Modify: `apps/server/src/web-gateway.ts`
- Modify: `apps/server/src/web-gateway.test.ts`
- Modify: `apps/server/src/napcat.ts`
- Modify: `apps/server/src/napcat.test.ts`
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/config.test.ts`
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/server-composition.test.ts`
- Modify: `apps/server/src/app.test.ts`
- Modify: `apps/demo/src/index.ts`
- Modify: `apps/demo/src/index.test.ts`

**Interfaces:**

- Produces: `InformationIngress` 只含 `submit(PlatformInboundMessage)`。
- Removes: `PlatformInboundMessage.traceId` 与 adapter 自造 Core 身份。
- Replaces: `KAGUYA_DATABASE_PATH`/`databasePath` with required `KAGUYA_DATABASE_URL`/`databaseUrl`。
- Preserves: `platformMessageId`、adapter/platform、sender、destination、mentions 与外部发生时间。

- [ ] **Step 1: 写 adapter 与 gateway RED 测试**

```ts
it("submits normalized content through the ingress only", async () => {
  const submitted: PlatformInboundMessage[] = [];
  const gateway = createWebMessageGateway({
    adapterId: "web.main",
    ingress: { submit: async (input) => { submitted.push(input); return receipt; } },
    logger,
  });
  gateway.ingest({ text: "hello" });
  await vi.waitFor(() => expect(submitted).toHaveLength(1));
  expect(submitted[0]).not.toHaveProperty("traceId");
});
```

NapCat 测试断言 adapter 只持有 callback/ingress，不导入数据库或模块。OneBot/Web normalization 测试断言外部 message ID 被保留，但没有 Core ID。

- [ ] **Step 2: 写 Server 配置 RED 测试**

```ts
it("requires the PostgreSQL information ledger URL", () => {
  expect(() => readServerConfig({ KAGUYA_GATEWAY_TOKEN: token }))
    .toThrow("KAGUYA_DATABASE_URL is required");
});
```

增加测试：Server 只把启动时选中的 Profile 构造成一个共享 model resolver；两个模块不能传 `profileId`；启动错误日志不包含 URL 中的 password。

- [ ] **Step 3: 运行边界测试并确认 RED**

```bash
pnpm vitest run packages/platform-adapters/src apps/server/src/web-gateway.test.ts apps/server/src/napcat.test.ts apps/server/src/config.test.ts apps/server/src/server-composition.test.ts apps/demo/src/index.test.ts
```

Expected: FAIL，因为 gateway 仍接收完整 Runtime，消息仍有 `traceId`，配置仍默认 SQLite path。

- [ ] **Step 4: 实现 ingress-only composition**

把 Gateway option 改为：

```ts
export interface CreateWebMessageGatewayOptions {
  readonly adapterId: string;
  readonly ingress: InformationIngress;
  readonly logger: KaguyaLogger;
}
```

NapCat adapter 同样只调用 `ingress.submit()`。Server 在读取全局 `selectedProfileId` 后创建唯一 resolver，并将 `databaseUrl` 交给 Runtime；任何日志只记录连接失败类型，不记录原始 URL。

- [ ] **Step 5: 更新 demo 并验证应用层**

demo 从 `KAGUYA_DATABASE_URL` 启动，提交一条确定性消息并输出根 `informationId` 与各 kind 计数。

```bash
pnpm vitest run packages/platform-adapters/src apps/server/src apps/demo/src
pnpm --filter @kaguya/platform-adapters typecheck
pnpm --filter @kaguya/server typecheck
pnpm --filter @kaguya/demo typecheck
```

Expected: PASS，序列化输出中不出现数据库密码。

- [ ] **Step 6: 提交 ingress 切片**

```bash
git add packages/platform-adapters/src apps/server/src apps/demo/src
git commit -m "refactor(ingress): submit platform content only to core"
```

### Task 6: 删除旧事件身份、SQLite 双写与兼容 API

**Files:**

- Create: `scripts/information-architecture.test.ts`
- Modify: `packages/schema/src/index.ts`
- Modify: `packages/schema/src/index.test.ts`
- Delete: `packages/sdk/src/modules.ts`
- Rename: `packages/sdk/src/information-modules.ts` to `packages/sdk/src/modules.ts`
- Modify: `packages/sdk/src/index.ts`
- Delete: `packages/engine/src/event-bus.ts`
- Delete: `packages/engine/src/event-bus.test.ts`
- Delete: `packages/engine/src/module-host.ts`
- Delete: `packages/engine/src/module-host.test.ts`
- Rename: `packages/engine/src/information-module-host.ts` to `packages/engine/src/module-host.ts`
- Rename: `packages/engine/src/information-module-host.test.ts` to `packages/engine/src/module-host.test.ts`
- Delete: `packages/engine/src/workflow-engine.ts`
- Delete: `packages/engine/src/workflow-engine.test.ts`
- Modify: `packages/engine/src/index.ts`
- Delete: `packages/modules/src/events.ts`
- Delete: `packages/modules/src/always-reply-filter.ts`
- Delete: `packages/modules/src/llm-reply.ts`
- Rename: `packages/modules/src/always-reply-information-filter.ts` to `packages/modules/src/always-reply-filter.ts`
- Rename: `packages/modules/src/llm-information-reply.ts` to `packages/modules/src/llm-reply.ts`
- Modify: `packages/modules/src/index.ts`
- Delete: `packages/runtime/src/events.ts`
- Delete: `packages/runtime/src/events.test.ts`
- Delete: `packages/runtime/src/dispatch.ts`
- Delete: `packages/runtime/src/dispatch.test.ts`
- Delete: `packages/runtime/src/services.ts`
- Delete: `packages/runtime/src/workflows.ts`
- Delete: `packages/runtime/src/workflows/message.ts`
- Modify: `packages/runtime/src/index.ts`
- Delete: `packages/database/src/migrations.ts`
- Delete: `packages/database/src/repositories.ts`
- Rename: `packages/database/src/postgres-driver.ts` to `packages/database/src/driver.ts`
- Rename: `packages/database/src/postgres-migrations.ts` to `packages/database/src/migrations.ts`
- Modify: `packages/database/src/index.ts`
- Modify: `packages/logger/src/index.ts`
- Modify: `packages/logger/src/index.test.ts`
- Modify: `packages/scheduler/src/index.test.ts`
- Modify: `scripts/workspace-smoke.mjs`

**Interfaces:**

- Removes: `EventEnvelope`、`EventBus`、`defineEvent`、`defineListener`、事件 ModuleHost/WorkflowEngine、旧记录 schemas/repositories。
- Promotes: 信息 ModuleHost 和 PostgreSQL database 为无 staged 前缀的最终公共名称。
- Removes: `append`、`getById`、`listByReference` 和 `PostgresKaguyaDatabase` 兼容别名。

- [ ] **Step 1: 写架构 RED 测试**

新增脚本扫描 production TypeScript，排除 `*.test.ts`、`dist` 和 `docs/ours`：

```ts
const forbidden = [
  /\bEventEnvelope\b/,
  /\bEventBus\b/,
  /\bdefineEvent\b/,
  /\bdefineListener\b/,
  /\btraceId\b/,
  /\beventId\b/,
  /\bmessageId\b/,
  /\brunId\b/,
  /\bMessageRecord\b/,
  /\bEventRun\b/,
  /\bLlmTrace\b/,
  /\bOutboundMessageRecord\b/,
  /\bnode:sqlite\b/,
  /\bgetById\b/,
  /\blistByReference\b/,
];
```

对 `profileId` 使用语义化白名单：允许 `packages/config` 与 Server Profile 管理路由；禁止 `packages/modules`、`packages/runtime`、`packages/platform-adapters` 的 production source 出现该字段。

- [ ] **Step 2: 运行架构测试并确认 RED**

```bash
pnpm exec tsx scripts/information-architecture.test.ts
rg -n "EventEnvelope|EventBus|defineEvent|defineListener|traceId|eventId|messageId|runId|MessageRecord|EventRun|LlmTrace|OutboundMessageRecord|node:sqlite|getById|listByReference" packages apps --glob '*.ts' --glob '!*.test.ts'
```

Expected: 脚本失败，`rg` 找到旧实现。

- [ ] **Step 3: 删除旧实现并提升最终名称**

使用 `git mv` 保留信息实现历史，更新每个 public `index.ts`，删除 SQLite schema/repository 和所有事件代码。移除旧 logger context 中的 trace/event/run ID，但保留 `informationId`、kind 和 source。

删除完成后运行：

```bash
pnpm exec tsx scripts/information-architecture.test.ts
pnpm typecheck
```

Expected: 架构测试与 typecheck PASS，`rg` 除明确的配置管理 Profile ID 外无旧 Core 身份匹配。

- [ ] **Step 4: 更新受删除影响的测试并验证包集合**

测试只迁移到新公共 API，不以 alias 让旧测试继续通过。运行：

```bash
pnpm vitest run packages/schema packages/sdk packages/engine packages/database packages/logger packages/llm packages/modules packages/platform-adapters packages/runtime packages/scheduler apps/server apps/demo
```

Expected: PASS。

- [ ] **Step 5: 提交删除切片**

```bash
git add packages apps scripts pnpm-lock.yaml
git commit -m "refactor(core): remove legacy event identities"
```

### Task 7: 更新公开文档并完成全量验收

**Files:**

- Modify: `README.md`
- Modify: `docs/developers/architecture.md`
- Modify: `docs/developers/contributing.md`
- Modify: `docs/developers/index.md`
- Modify: `docs/developers/information-modules.md`
- Modify: `docs/guide/installation.md`
- Modify: `docs/guide/webui.md`
- Modify: `docs/reference/environment-variables.md`
- Modify: `docs/reference/http-api.md`
- Modify: `docs/reference/index.md`
- Modify: `docs/project/index.md`

**Interfaces:**

- Documents: 单一 `informationId`、持久化优先顺序、`onInformation/context.register`、显式过滤 DAG、失败事实、PostgreSQL 配置与全局 Profile。
- States explicitly: 无离线补投、工作队列、自动重试或旧 SQLite 数据迁移。

- [ ] **Step 1: 从最终代码更新公开文档**

再次阅读 `docs/developers/markdown-features.md`，然后把旧 EventBus/SQLite/Session/trace 图和示例替换为已交付接口。`information-modules.md` 使用以下最小示例：

```ts
onInformation(inboundTextKind, async (atom, context) => {
  await context.register(replyRequestedKind, {
    payload: { text: atom.payload.text, source: atom.payload.source },
  });
});
```

不把内部 spec 或 plan 加入 sidebar；公开页面只陈述当前代码已实现的能力。

- [ ] **Step 2: 运行文档与格式检查**

```bash
pnpm format:check
pnpm --filter @kaguya/docs docs:check
git diff --check
```

Expected: 全部 PASS。

- [ ] **Step 3: 运行完整测试、静态检查和构建**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected: 四条命令全部退出 0；测试无 unhandled rejection 或 warning。

- [ ] **Step 4: 复核验收条件**

```bash
pnpm exec tsx scripts/information-architecture.test.ts
rg -n "EventEnvelope|EventBus|defineEvent|defineListener|traceId|eventId|messageId|runId|MessageRecord|EventRun|LlmTrace|OutboundMessageRecord|node:sqlite|getById|listByReference" packages apps --glob '*.ts' --glob '!*.test.ts'
git diff --check
git status --short
```

Expected: 架构测试 PASS；`rg` 无匹配；diff check 无输出；工作区只包含计划内变更。

- [ ] **Step 5: 提交文档与最终修正**

```bash
git add README.md docs packages apps scripts pnpm-lock.yaml
git commit -m "docs: describe the persisted information DAG"
```

若前一步未产生源码修正，提交仅包含公开文档；不得创建空提交。
