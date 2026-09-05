# Information Selector、Prompt 与 Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提供由 Core 校验和加载的 informationId Selector，让 reply Prompt 与 Memory 只使用显式落账、可按引用追溯的运行上下文。

**Architecture:** SDK 只定义 Selector 与受限只读读取器；Engine 为每次 `context.select` 创建独立授权作用域，Database 实现结构化查询，业务模块只把 Core 返回的不可变原子渲染为 Prompt。LLM requested 和 Memory 使用有序 `core:uses-context` 引用保存实际输入，不建立 Session 或隐式历史桶。

**Tech Stack:** TypeScript 6、Zod 4、Vitest 4、pnpm workspace、PostgreSQL/PGlite、VitePress。

**Spec:** `docs/ours/superpowers/specs/2026-09-04-information-selector-prompt-memory-design.md`

## Global Constraints

- 开始任何源码修改前，确认 #40 owner 已完成最终提交；将 `feat/issue-40-information-dag` 的最终 HEAD 合入本分支，解决冲突后重新运行基线 `pnpm exec tsc -b --pretty false && pnpm test`。
- Selector 最终只能返回有序、无重复的 `informationId[]`；Core 负责重新加载原子，业务模块不能直接读取 repository 或拼装未落账上下文。
- “越权”是单次选择作用域边界：合法 ID 只能来自当前 source，或本次 `find`、`related`、`retrieve` 实际返回的候选。
- 默认 Selector 只选择当前 `core.reply.requested`，不得根据 sender、group、destination、时间或 `core:context` 自动聚合历史。
- Memory 使用普通 `core.memory.text` kind，并通过一个或多个有序 `core:uses-context` 引用记录输入。
- Memory、Prompt 和 reply 生产路径不得出现 `sessionId` 或 `contextKey`。
- 不实现权限系统、内置向量/全文检索、自动 Memory 提取、Selector 持久化、队列或重试。
- 所有新增或修改的 TypeScript 文件都维护准确的中文头部注释，覆盖职责、关键导出、依赖关系、输入输出、副作用和并发/持久化语义。
- 每个行为必须保留真实 RED→GREEN：RED 必须因目标行为缺失而失败，不能以导入、构建或环境错误冒充；开发期只运行计划指定的单测或单文件，交付前才执行全量验证。
- 测试应断言真实组件的可观察行为；手工推导期望值，不用生产 helper 计算 expected，也不把 mock 调用本身当作主要结论。

---

### Task 1: 定义 Selector SDK 公共契约

**Files:**

- Create: `packages/sdk/src/information-selector.ts`
- Create: `packages/sdk/src/information-selector.test.ts`
- Modify: `packages/sdk/src/modules.ts:1-52`
- Modify: `packages/sdk/src/index.ts:1-33`
- Test: `packages/sdk/src/information-selector.test.ts`
- Test: `packages/sdk/src/information-modules.test.ts`

**Interfaces:**

- Produces: `defineInformationSelector(definition): InformationSelectorDefinition`
- Produces: `InformationFindQuery`, `InformationRelatedQuery`, `InformationRetrievalQuery`
- Produces: `InformationSelectorLedger`, `InformationSelectorContext`, `InformationSelectorDefinition`
- Produces: `InformationModuleHandlerContext.select(selector): Promise<readonly DeepReadonly<InformationAtom>[]>`
- Consumes: `InformationId`, `InformationAtom`, `DeepReadonly`, `JsonObject` from `@kaguya/schema`

- [ ] **Step 1: Write the failing Selector definition tests**

Create `packages/sdk/src/information-selector.test.ts` with a Chinese header and tests that exercise the public API rather than its private shape:

```ts
import { describe, expect, it } from "vitest";

import * as sdk from "./index.js";

function selectorFactory() {
  expect(sdk).toHaveProperty("defineInformationSelector");
  return (
    sdk as typeof sdk & {
      defineInformationSelector: (input: {
        selectorId: string;
        select: () => readonly string[];
      }) => { selectorId: string; select: () => readonly string[] };
    }
  ).defineInformationSelector;
}

describe("defineInformationSelector", () => {
  it("normalizes a non-blank selector id and freezes the definition", () => {
    const defineInformationSelector = selectorFactory();
    const select = () => ["information-1"] as const;
    const definition = defineInformationSelector({
      selectorId: "  reply.current  ",
      select,
    });

    expect(definition).toEqual({ selectorId: "reply.current", select });
    expect(Object.isFrozen(definition)).toBe(true);
  });

  it.each(["", "   "])("rejects a blank selector id %j", (selectorId) => {
    const defineInformationSelector = selectorFactory();
    expect(() =>
      defineInformationSelector({ selectorId, select: () => [] }),
    ).toThrow("information selector id must not be blank");
  });
});
```

The first assertion must fail with `expected object to have property "defineInformationSelector"`; an ESM missing-export or module-resolution error is not an acceptable RED.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm exec vitest run packages/sdk/src/information-selector.test.ts
```

Expected: FAIL at the explicit export assertion because `./index.js` does not expose `defineInformationSelector`. The test file itself must load and run.

- [ ] **Step 3: Implement the minimal SDK contract**

Create `information-selector.ts` with the exact public shapes:

```ts
import type {
  DeepReadonly,
  InformationAtom,
  InformationId,
  JsonObject,
} from "@kaguya/schema";

export interface InformationFindQuery {
  readonly kinds?: readonly string[];
  readonly sources?: readonly string[];
  readonly occurredAfter?: string;
  readonly occurredBefore?: string;
  readonly limit: number;
}

export interface InformationRelatedQuery {
  readonly from: readonly InformationId[];
  readonly relation?: string;
  readonly direction: "outgoing" | "incoming";
  readonly limit: number;
}

export interface InformationRetrievalQuery {
  readonly strategyId: string;
  readonly input: JsonObject;
  readonly limit: number;
}

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

export interface InformationSelectorContext {
  readonly sourceAtom: DeepReadonly<InformationAtom>;
  readonly ledger: InformationSelectorLedger;
}

export interface InformationSelectorDefinition {
  readonly selectorId: string;
  select(
    context: InformationSelectorContext,
  ): readonly InformationId[] | Promise<readonly InformationId[]>;
}

export function defineInformationSelector(
  definition: InformationSelectorDefinition,
): InformationSelectorDefinition {
  const selectorId = definition.selectorId.trim();
  if (selectorId.length === 0) {
    throw new Error("information selector id must not be blank");
  }
  return Object.freeze({ selectorId, select: definition.select });
}
```

Export every public symbol from `packages/sdk/src/index.ts`. Import `InformationSelectorDefinition` in `modules.ts` and add the exact `select` method to `InformationModuleHandlerContext`. Update both files' existing Chinese headers to mention Selector and `context.select`.

After the runtime assertions turn green, add this compile-time guard to the test file:

```ts
sdk.defineInformationSelector({
  selectorId: "invalid.atom-result",
  // @ts-expect-error Selector results contain informationId values, not atoms.
  select: () => [{ informationId: "information-1" }],
});
```

- [ ] **Step 4: Verify GREEN with the smallest radius**

Run:

```bash
pnpm exec vitest run packages/sdk/src/information-selector.test.ts packages/sdk/src/information-modules.test.ts
pnpm --filter @kaguya/sdk typecheck
```

Expected: both files PASS and the package typecheck accepts the `@ts-expect-error` guard without an unused-directive failure.

- [ ] **Step 5: Commit the SDK boundary**

```bash
git add packages/sdk/src/information-selector.ts packages/sdk/src/information-selector.test.ts packages/sdk/src/modules.ts packages/sdk/src/index.ts
git commit -m "feat(sdk): define information selectors"
```

### Task 2: 为账本实现受控的 kind、source 与时间查询

**Files:**

- Modify: `packages/engine/src/information-core.ts:60-109`
- Modify: `packages/engine/src/information-core.test.ts:103-164`
- Modify: `packages/modules/src/information-modules.test.ts:95-154`
- Modify: `packages/database/src/information-repository.ts:1-320`
- Modify: `packages/database/src/information-repository.test.ts`
- Modify: `packages/database/src/migrations.ts:1-120`
- Test: `packages/database/src/information-repository.test.ts`

**Interfaces:**

- Consumes: `InformationFindQuery` from `@kaguya/sdk`
- Produces: `InformationLedger.find(query): Promise<readonly DeepReadonly<InformationAtom>[]>`
- Preserves: existing `get`, `getMany`, and incoming-reference `query`

- [ ] **Step 1: Write failing repository query tests**

In `information-repository.test.ts`, add fixtures at deliberately non-sorted insertion times and sources, including one timestamp with a non-UTC offset. Add these tests with literal expected ID arrays:

```ts
it("finds atoms by kind and source in chronological order", async () => {
  // Append: other kind, matching later atom, matching earlier atom, other source.
  const found = await database.information.find({
    kinds: [replyKind.kind],
    sources: ["module:reply"],
    limit: 10,
  });

  expect(found.map(({ informationId }) => informationId)).toEqual([
    "atom-reply-earlier",
    "atom-reply-later",
  ]);
});

it("uses a half-open occurredAt interval", async () => {
  const found = await database.information.find({
    occurredAfter: "2026-09-04T00:00:01.000Z",
    occurredBefore: "2026-09-04T00:00:03.000Z",
    limit: 10,
  });

  expect(found.map(({ informationId }) => informationId)).toEqual([
    "atom-at-lower-bound",
    "atom-inside-window",
  ]);
});

it("applies limit after deterministic ordering", async () => {
  const found = await database.information.find({
    kinds: [replyKind.kind],
    limit: 1,
  });
  expect(found.map(({ informationId }) => informationId)).toEqual([
    "atom-reply-earlier",
  ]);
});
```

The offset fixture must prove chronological comparison, for example `2026-09-04T08:00:00+08:00` sorts at the same instant as `2026-09-04T00:00:00Z`, with `informationId` breaking the tie.

- [ ] **Step 2: Verify repository RED**

Run:

```bash
pnpm exec vitest run packages/database/src/information-repository.test.ts -t "finds atoms|half-open|applies limit"
```

Expected: FAIL because `InformationRepository.find` does not exist.

- [ ] **Step 3: Extend the ledger port and PostgreSQL implementation**

Import `InformationFindQuery` from `@kaguya/sdk` and add `find(query: InformationFindQuery)` to `InformationLedger`. Do not duplicate or re-export the SDK query type from Engine, and add no Selector-specific method to the database repository. Engine will compose `related` from existing `query` plus `getMany` in Task 3.

Implement `InformationRepository.find` with parameterized predicates. The SQL builder must never interpolate user values; only generated placeholder numbers may be interpolated:

```ts
async find(
  query: InformationFindQuery,
): Promise<readonly DeepReadonly<InformationAtom>[]> {
  return this.database.transaction(async (tx) => {
    const values: unknown[] = [];
    const predicates: string[] = [];
    const bind = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };

    if (query.kinds !== undefined) {
      predicates.push(`a.kind = ANY(${bind([...query.kinds])}::text[])`);
    }
    if (query.sources !== undefined) {
      predicates.push(`a.source = ANY(${bind([...query.sources])}::text[])`);
    }
    if (query.occurredAfter !== undefined) {
      predicates.push(
        `a.occurred_at::timestamptz >= ${bind(query.occurredAfter)}::timestamptz`,
      );
    }
    if (query.occurredBefore !== undefined) {
      predicates.push(
        `a.occurred_at::timestamptz < ${bind(query.occurredBefore)}::timestamptz`,
      );
    }
    const limit = bind(query.limit);
    const rows = await tx.query<{ information_id: string }>(
      `SELECT a.information_id
       FROM information_atoms a
       WHERE ${predicates.join(" AND ")}
       ORDER BY a.occurred_at::timestamptz ASC, a.information_id ASC
       LIMIT ${limit}`,
      values,
    );
    return readAtomsByRows(tx, rows.rows);
  });
}
```

Extract `readAtomsByRows` only after the test is green, and keep it private. Add a source index in `migrations.ts` and increment `POSTGRES_SCHEMA_VERSION` from `2` to `3`:

```sql
CREATE INDEX IF NOT EXISTS information_atoms_source_occurred_at_idx
  ON information_atoms (source, occurred_at, information_id);
```

Update the two in-memory ledger doubles with a deterministic `find` implementation matching the port so TypeScript structural checks remain honest; do not add test-only methods to production classes.

- [ ] **Step 4: Verify repository GREEN**

Run:

```bash
pnpm exec vitest run packages/database/src/information-repository.test.ts -t "finds atoms|half-open|applies limit"
pnpm --filter @kaguya/database typecheck
```

Expected: focused cases PASS; package typecheck confirms the production repository and both test doubles satisfy `InformationLedger`.

- [ ] **Step 5: Commit the structured ledger query**

```bash
git add packages/engine/src/information-core.ts packages/engine/src/information-core.test.ts packages/modules/src/information-modules.test.ts packages/database/src/information-repository.ts packages/database/src/information-repository.test.ts packages/database/src/migrations.ts
git commit -m "feat(database): query information for selectors"
```

### Task 3: 在 Core 中执行、授权并加载 Selector 结果

**Files:**

- Create: `packages/engine/src/information-selector.ts`
- Create: `packages/engine/src/information-selector.test.ts`
- Modify: `packages/engine/src/information-errors.ts:1-75`
- Modify: `packages/engine/src/information-core.ts:102-340`
- Modify: `packages/engine/src/index.ts:16-36`
- Test: `packages/engine/src/information-selector.test.ts`

**Interfaces:**

- Consumes: `InformationSelectorDefinition` and query types from `@kaguya/sdk`
- Consumes: `InformationLedger.find/get/getMany/query`
- Produces: `InformationRetrievalStrategy`
- Produces: `InformationCore.select(selector, sourceInformationId)`
- Produces: stable errors for invalid, source-missing, duplicate, unknown, unauthorized, final-missing, invalid-query, and unknown-strategy cases

- [ ] **Step 1: Write failing selection validation tests**

Create a real in-memory `InformationLedger` double in `information-selector.test.ts` and register two atoms through `InformationCore`. Add literal behavior tests:

```ts
it("returns selected atoms in selector order", async () => {
  const { core, source, memory } = await fixture();
  const selector = defineInformationSelector({
    selectorId: "test.ordered",
    async select({ sourceAtom, ledger }) {
      const found = await ledger.find({ kinds: [memory.kind], limit: 10 });
      return [found[0]!.informationId, sourceAtom.informationId];
    },
  });

  const selected = await core.select(selector, source.informationId);
  expect(selected.map(({ informationId }) => informationId)).toEqual([
    memory.informationId,
    source.informationId,
  ]);
});

it("rejects duplicate selected ids", async () => {
  const { core, source } = await fixture();
  const selector = defineInformationSelector({
    selectorId: "test.duplicate",
    select: () => [source.informationId, source.informationId],
  });
  await expect(
    core.select(selector, source.informationId),
  ).rejects.toBeInstanceOf(DuplicateSelectedInformationIdError);
});

it("distinguishes unknown from unauthorized ids", async () => {
  const { core, source, memory } = await fixture();
  await expect(
    core.select(
      defineInformationSelector({
        selectorId: "test.unknown",
        select: () => ["missing-information"],
      }),
      source.informationId,
    ),
  ).rejects.toBeInstanceOf(UnknownSelectedInformationIdError);

  await expect(
    core.select(
      defineInformationSelector({
        selectorId: "test.unauthorized",
        select: () => [memory.informationId],
      }),
      source.informationId,
    ),
  ).rejects.toBeInstanceOf(UnauthorizedSelectedInformationIdError);
});
```

Add separate tests that make the ledger omit the source, then omit one ID only on final reload, and assert `SelectorSourceInformationMissingError` and `SelectedInformationMissingError` respectively.

- [ ] **Step 2: Verify validation RED**

Run:

```bash
pnpm exec vitest run packages/engine/src/information-selector.test.ts -t "selector order|duplicate|unknown|unauthorized|source|final"
```

Expected: FAIL because `InformationCore.select` and the error classes do not exist.

- [ ] **Step 3: Implement stable errors and the per-call executor**

Add errors extending `InformationEngineError`, each retaining `selectorId` and relevant `informationId`. Use these exact messages:

```ts
new InvalidInformationSelectionError(selectorId, cause);
// `Invalid information selection: ${selectorId}`

new SelectorSourceInformationMissingError(selectorId, informationId);
// `Selector source information is missing: ${selectorId} -> ${informationId}`

new DuplicateSelectedInformationIdError(selectorId, informationId);
// `Selector returned duplicate information id: ${selectorId} -> ${informationId}`

new UnknownSelectedInformationIdError(selectorId, informationId);
// `Selector returned unknown information id: ${selectorId} -> ${informationId}`

new UnauthorizedSelectedInformationIdError(selectorId, informationId);
// `Selector returned unauthorized information id: ${selectorId} -> ${informationId}`

new SelectedInformationMissingError(selectorId, informationId);
// `Selected information disappeared during load: ${selectorId} -> ${informationId}`

new InvalidSelectorQueryError(selectorId, operation, cause);
// `Invalid selector query: ${selectorId} -> ${operation}`

new UnknownRetrievalStrategyError(selectorId, strategyId);
// `Unknown information retrieval strategy: ${selectorId} -> ${strategyId}`
```

Define the injected retrieval boundary exactly once in `information-selector.ts`:

```ts
export interface InformationRetrievalStrategy {
  readonly strategyId: string;
  retrieve(input: {
    readonly input: JsonObject;
    readonly limit: number;
  }): Promise<readonly InformationId[]>;
}
```

Implement `InformationSelectorExecutor` in the new focused file. Its `select` method must:

```ts
async select(
  selector: InformationSelectorDefinition,
  sourceInformationId: InformationId,
): Promise<readonly DeepReadonly<InformationAtom>[]> {
  const sourceAtom = await this.ledger.get(sourceInformationId);
  if (sourceAtom === undefined) {
    throw new SelectorSourceInformationMissingError(
      selector.selectorId,
      sourceInformationId,
    );
  }

  const scope = new SelectorReadScope(this.ledger, this.strategies, sourceAtom);
  const raw = await selector.select({ sourceAtom, ledger: scope.reader });
  const ids = parseSelection(selector.selectorId, raw);
  assertUnique(selector.selectorId, ids);

  const firstLoad = indexById(await this.ledger.getMany(ids));
  for (const id of ids) {
    if (!firstLoad.has(id)) {
      throw new UnknownSelectedInformationIdError(selector.selectorId, id);
    }
    if (!scope.isAuthorized(id)) {
      throw new UnauthorizedSelectedInformationIdError(selector.selectorId, id);
    }
  }

  const finalLoad = indexById(await this.ledger.getMany(ids));
  return Object.freeze(
    ids.map((id) => {
      const atom = finalLoad.get(id);
      if (atom === undefined) {
        throw new SelectedInformationMissingError(selector.selectorId, id);
      }
      return atom;
    }),
  );
}
```

`parseSelection` must use `z.array(informationIdSchema).safeParse` and copy/freeze the ID array. Empty output is valid for a generic Selector; reply-specific code will require the source in Task 6.

`InformationCoreOptions` gains `retrievalStrategies?: readonly InformationRetrievalStrategy[]`; constructor rejects blank or duplicate strategy IDs and creates one executor. `InformationCore.select` checks started state, parses the source ID through the existing ID parser, and delegates. Re-export public errors and strategy types through `packages/engine/src/index.ts`.

- [ ] **Step 4: Write failing reader, reference, retrieval, and concurrency tests**

Add the following independent tests with hand-written fixtures and literal expectations:

- `requires a constrained find query and a limit from 1 through 1000` calls `ledger.find({ limit: 10 })`, `ledger.find({ kinds: [parentKind], limit: 0 })`, and `ledger.find({ kinds: [parentKind], limit: 1001 })`; every promise rejects with `InvalidSelectorQueryError`.
- `loads outgoing references by source order and reference ordinal` starts from two authorized atoms whose reference arrays point to literal IDs `["target-b", "target-a"]` and `["target-c"]`; the returned IDs are `["target-b", "target-a", "target-c"]`.
- `loads incoming references by source order and deterministic atom order` uses two authorized starts and ledger `query` results `[incomingB, incomingA]` and `[incomingC]`; the reader returns `[incomingB, incomingA, incomingC]` without re-sorting a ledger result.
- `rejects a related traversal whose start id is not authorized` passes a known but unread ID as `from` and rejects with `UnauthorizedSelectedInformationIdError` carrying that ID.
- `rejects an unknown retrieval strategy` calls `retrieve({ strategyId: "missing", input: {}, limit: 1 })` and rejects with `UnknownRetrievalStrategyError`.
- `authorizes ids returned by a registered retrieval strategy` registers `test.memory`, returns `[memory.informationId]`, and proves the Selector may return that ID.
- `keeps concurrent selector authorization scopes isolated` uses the barrier described below and expects two unauthorized failures.

The concurrency test must use one shared Selector and a barrier. Register a retrieval strategy that returns candidate A for `{ key: "A" }` and candidate B for `{ key: "B" }`; after both calls have retrieved their own candidate, make each invocation return the other candidate. Assert that both calls reject with `UnauthorizedSelectedInformationIdError`. A shared/global authorization set would incorrectly make both pass.

- [ ] **Step 5: Verify reader tests RED**

Run:

```bash
pnpm exec vitest run packages/engine/src/information-selector.test.ts -t "find query|outgoing|incoming|traversal|retrieval|concurrent"
```

Expected: validation tests from Step 3 pass, while the new reader/retrieval tests fail because the read scope methods are not implemented.

- [ ] **Step 6: Implement the restricted reader and query validation**

Use Zod schemas internal to Engine to enforce:

```ts
const limitSchema = z.number().int().min(1).max(1_000);
const findSchema = z
  .object({
    kinds: z.array(z.string().trim().min(1)).min(1).optional(),
    sources: z.array(z.string().trim().min(1)).min(1).optional(),
    occurredAfter: z.iso.datetime({ offset: true }).optional(),
    occurredBefore: z.iso.datetime({ offset: true }).optional(),
    limit: limitSchema,
  })
  .strict()
  .refine(
    ({ kinds, sources, occurredAfter, occurredBefore }) =>
      kinds !== undefined ||
      sources !== undefined ||
      occurredAfter !== undefined ||
      occurredBefore !== undefined,
    "selector find query must include a filter",
  );
```

Also reject `occurredAfter >= occurredBefore` after parsing instants. `related.from` must be non-empty, unique, already authorized, and limited to one hop. For outgoing traversal, inspect each authorized atom's frozen references in ordinal order, filter relation, bulk-load target IDs, reject missing targets, then stable-deduplicate. For incoming traversal, call existing `ledger.query({ informationId, relation })` once per start ID, concatenate in start order, then stable-deduplicate and apply the global limit.

`retrieve` validates nonblank strategy ID, JSON-compatible input, and limit. The strategy returns only IDs; Core parses and stable-deduplicates them, bulk-loads every ID, rejects any missing target, and only then adds them to the current scope. None of these methods expose `get`, writes, subscriptions, SQL, transaction, Core, or repository.

- [ ] **Step 7: Verify complete Engine GREEN**

Run:

```bash
pnpm exec vitest run packages/engine/src/information-selector.test.ts
pnpm --filter @kaguya/engine typecheck
```

Expected: all Selector tests PASS, including both concurrent unauthorized failures.

- [ ] **Step 8: Commit Core selection**

```bash
git add packages/engine/src/information-selector.ts packages/engine/src/information-selector.test.ts packages/engine/src/information-errors.ts packages/engine/src/information-core.ts packages/engine/src/index.ts
git commit -m "feat(core): validate information selections"
```

### Task 4: 将 `context.select` 接入 ModuleHost

**Files:**

- Modify: `packages/engine/src/module-host.ts:1-286`
- Modify: `packages/engine/src/module-host.test.ts`
- Test: `packages/engine/src/module-host.test.ts`

**Interfaces:**

- Consumes: `InformationCore.select(selector, sourceInformationId)`
- Implements: SDK `InformationModuleHandlerContext.select`
- Preserves: automatic `core:caused-by` and `core:context` behavior for `context.register`

- [ ] **Step 1: Write the failing host-level selection test**

Add a module whose real handler selects its source and registers the selected ID in an output payload:

```ts
const currentSelector = defineInformationSelector({
  selectorId: "test.current",
  select: ({ sourceAtom }) => [sourceAtom.informationId],
});

const module = defineInformationModule({
  manifest: {
    apiVersion: 1,
    definitionId: "acme.selector-consumer",
    displayName: "Selector consumer",
    settingsSchema: z.object({}).strict(),
    informationKinds: [inputKind, outputKind],
  },
  create: () => ({
    subscriptions: [
      onInformation(inputKind, async (_atom, context) => {
        const selected = await context.select(currentSelector);
        await context.register(outputKind, {
          payload: { selectedId: selected[0]!.informationId },
        });
      }),
    ],
  }),
});
```

Register the input through a real `InformationCore` and `ModuleHost`; assert the output payload contains the persisted input ID. Add a second module whose Selector throws `new Error("selection failed")`; assert the existing Core path records one `consumer.failed` for the input instead of emitting an unhandled rejection.

- [ ] **Step 2: Verify ModuleHost RED**

Run:

```bash
pnpm exec vitest run packages/engine/src/module-host.test.ts -t "selects persisted source|selection failure"
```

Expected: FAIL because the host-created handler context has no `select` implementation.

- [ ] **Step 3: Add the minimal host delegation**

Update `createContext` without exposing Core itself:

```ts
return {
  definitionId: module.definition.manifest.definitionId,
  instanceId: module.instanceId,
  sourceAtom,
  now,
  select: (selector) =>
    this.#options.core.select(selector, sourceAtom.informationId),
  register: async (definition, input) => {
    // Preserve the existing declaration and reserved-reference checks verbatim.
  },
};
```

Do not catch Selector errors in ModuleHost; Core's existing bus settlement must continue to produce `consumer.failed`. Update the file header to describe both context capabilities.

- [ ] **Step 4: Verify ModuleHost GREEN**

Run:

```bash
pnpm exec vitest run packages/engine/src/module-host.test.ts -t "selects persisted source|selection failure"
pnpm --filter @kaguya/engine typecheck
```

Expected: selected ID is persisted in the derived atom, and the throwing Selector produces exactly one `consumer.failed`.

- [ ] **Step 5: Commit host integration**

```bash
git add packages/engine/src/module-host.ts packages/engine/src/module-host.test.ts
git commit -m "feat(engine): expose selector context to modules"
```

### Task 5: 给 Prompt fragment 和 provenance 增加 informationId

**Files:**

- Modify: `packages/schema/src/index.ts:55-100`
- Modify: `packages/schema/src/index.test.ts:1-29`
- Modify: `packages/prompt/src/index.ts:1-40`
- Modify: `packages/prompt/src/index.test.ts:1-82`
- Test: `packages/schema/src/index.test.ts`
- Test: `packages/prompt/src/index.test.ts`

**Interfaces:**

- Produces: optional `PromptFragment.informationId`
- Produces: optional `CompiledPrompt.provenance[].informationId`
- Preserves: static fragments without an information ID and existing SHA-256 digest behavior

- [ ] **Step 1: Write failing schema and compiler tests**

Add a schema test with a literal round trip:

```ts
it("preserves an information id on a dynamic prompt fragment", () => {
  expect(
    promptFragmentSchema.parse({
      id: "reply-current",
      informationId: "reply-42",
      source: "history",
      priority: 20,
      content: "hello",
      metadata: {},
    }),
  ).toMatchObject({ informationId: "reply-42" });
});
```

Add a PromptCompiler test:

```ts
it("copies a dynamic information id into provenance", () => {
  const compiled = compiler.compile("reply", [
    {
      ...fragment("history", 20, "hello"),
      informationId: "reply-42",
    },
  ]);

  expect(compiled.provenance[0]).toMatchObject({
    fragmentId: "history-id",
    informationId: "reply-42",
    source: "history",
    priority: 20,
  });
});
```

Keep the existing static provenance test and assert it does not gain an `informationId` property.

- [ ] **Step 2: Verify Prompt provenance RED**

Run:

```bash
pnpm exec vitest run packages/schema/src/index.test.ts packages/prompt/src/index.test.ts -t "information id|SHA-256 provenance"
```

Expected: FAIL because the schema strips the new property and the compiler does not copy it.

- [ ] **Step 3: Extend schema and compiler minimally**

Add `informationId: informationIdSchema.optional()` to `promptFragmentSchema` and the provenance entry schema. In `PromptCompiler.compile`, spread the optional field only when present:

```ts
provenance: sortedFragments.map((fragment) => ({
  fragmentId: fragment.id,
  ...(fragment.informationId === undefined
    ? {}
    : { informationId: fragment.informationId }),
  source: fragment.source,
  priority: fragment.priority,
  contentDigest: createHash("sha256").update(fragment.content).digest("hex"),
})),
```

Do not require IDs on generic Prompt fragments; reply rendering enforces dynamic provenance in Task 6. Update both source headers to describe the optional provenance link.

- [ ] **Step 4: Verify Prompt provenance GREEN**

Run:

```bash
pnpm exec vitest run packages/schema/src/index.test.ts packages/prompt/src/index.test.ts
pnpm --filter @kaguya/prompt typecheck
```

Expected: both files PASS; existing static fragment and escaping behavior remain unchanged.

- [ ] **Step 5: Commit Prompt provenance**

```bash
git add packages/schema/src/index.ts packages/schema/src/index.test.ts packages/prompt/src/index.ts packages/prompt/src/index.test.ts
git commit -m "feat(prompt): trace fragments to information ids"
```

### Task 6: 定义 Memory kind，并让 reply 模块只编译已选择原子

**Files:**

- Create: `packages/modules/src/reply-context.ts`
- Create: `packages/modules/src/reply-context.test.ts`
- Modify: `packages/modules/src/information-kinds.ts:1-156`
- Modify: `packages/modules/src/llm-reply.ts:1-174`
- Modify: `packages/modules/src/information-modules.test.ts`
- Modify: `packages/modules/src/index.ts`
- Test: `packages/modules/src/reply-context.test.ts`
- Test: `packages/modules/src/information-modules.test.ts`

**Interfaces:**

- Produces: `coreMemoryTextInformationKind`
- Produces: `currentAcceptedMessageSelector`
- Produces: `compileReplyPromptFromInformation(atoms, sourceInformationId)`
- Changes: `LlmReplyExecutor.execute` receives reloaded `reply`, compiled `prompt`, and ordered `contextAtoms`
- Changes: `CreateLlmReplyModuleOptions` accepts optional `selector` and `promptCompiler`

- [ ] **Step 1: Write failing default Selector and Memory kind tests**

In `reply-context.test.ts`, call the default Selector with a ledger double whose methods throw if invoked:

```ts
it("selects only the current accepted message without querying history", async () => {
  const ids = await currentAcceptedMessageSelector.select({
    sourceAtom: replyAtom,
    ledger: {
      find: async () => Promise.reject(new Error("unexpected find")),
      related: async () => Promise.reject(new Error("unexpected related")),
      retrieve: async () => Promise.reject(new Error("unexpected retrieve")),
    },
  });
  expect(ids).toEqual([replyAtom.informationId]);
});
```

In `information-modules.test.ts`, assert the Memory definition accepts ordered `core:uses-context` references through a real Core/ModuleHost registration and that its definition requires `core:caused-by`, `core:context`, and repeatable `core:uses-context`. Use two input IDs and assert their literal order.

- [ ] **Step 2: Verify default/Memory RED**

Run:

```bash
pnpm exec vitest run packages/modules/src/reply-context.test.ts packages/modules/src/information-modules.test.ts -t "current accepted|Memory|uses-context"
```

Expected: FAIL because neither the default Selector nor `coreMemoryTextInformationKind` exists.

- [ ] **Step 3: Add the default Selector and Memory definition**

Define `core.memory.text` with strict `{ text: z.string().trim().min(1) }` payload and these references:

```ts
references: {
  "core:caused-by": { required: true, multiple: false },
  "core:context": {
    required: true,
    multiple: false,
    targetKinds: ["core.runtime.context"],
  },
  "core:uses-context": { required: true, multiple: true },
},
```

Include it once in `informationModuleKinds`. Create and export `currentAcceptedMessageSelector` exactly as a source-only Selector. Do not inspect message payload fields or call the reader.

- [ ] **Step 4: Write failing reply rendering and module tests**

Add literal rendering tests:

```ts
it("renders selected reply and Memory atoms in selector order", () => {
  const prompt = compileReplyPromptFromInformation(
    new PromptCompiler(),
    [memoryAtom, replyAtom],
    replyAtom.informationId,
  );

  expect(
    prompt.fragments.map(({ informationId, source, content }) => ({
      informationId,
      source,
      content,
    })),
  ).toEqual([
    {
      informationId: memoryAtom.informationId,
      source: "memory",
      content: "likes tea",
    },
    {
      informationId: replyAtom.informationId,
      source: "history",
      content: "hello",
    },
  ]);
});

it("rejects a selection that omits the current reply", () => {
  expect(() =>
    compileReplyPromptFromInformation(
      new PromptCompiler(),
      [memoryAtom],
      replyAtom.informationId,
    ),
  ).toThrow("Reply selection must include the current input");
});

it("rejects an atom kind without an explicit reply renderer", () => {
  const unsupported = freezeInformationAtom({
    informationId: informationIdSchema.parse("unsupported-1"),
    kind: "acme.unsupported",
    occurredAt: "2026-09-04T00:00:00.000Z",
    source: "module:test",
    payload: { text: "must not leak into Prompt" },
    references: [],
  });
  expect(() =>
    compileReplyPromptFromInformation(
      new PromptCompiler(),
      [replyAtom, unsupported],
      replyAtom.informationId,
    ),
  ).toThrow("Unsupported reply context information kind: acme.unsupported");
});
```

Update the existing reply subscription test so its handler context `select` returns a separately frozen persisted reply plus Memory atom. Assert `executor.execute` receives those same ordered atoms, a Prompt whose provenance IDs match them, and the reloaded reply rather than the original handler object.

- [ ] **Step 5: Verify reply RED**

Run:

```bash
pnpm exec vitest run packages/modules/src/reply-context.test.ts packages/modules/src/information-modules.test.ts -t "selector order|omits|renderer|reloaded reply"
```

Expected: default/Memory tests pass; rendering and executor-input tests fail because reply still forwards the handler payload directly.

- [ ] **Step 6: Implement the atom-to-Prompt boundary**

In `reply-context.ts`, map only two supported kinds. Preserve Selector order by assigning every dynamic fragment the same priority and relying on PromptCompiler's stable original-position tie-break:

```ts
export function compileReplyPromptFromInformation(
  compiler: PromptCompiler,
  atoms: readonly DeepReadonly<InformationAtom>[],
  sourceInformationId: InformationId,
): CompiledPrompt {
  if (
    !atoms.some(({ informationId }) => informationId === sourceInformationId)
  ) {
    throw new Error("Reply selection must include the current input");
  }
  const fragments = atoms.map((atom): PromptFragment => {
    if (atom.kind === replyRequestedInformationKind.kind) {
      const payload = replyRequestedInformationPayloadSchema.parse(
        atom.payload,
      );
      return fragment(atom.informationId, "history", payload.text);
    }
    if (atom.kind === coreMemoryTextInformationKind.kind) {
      const payload = coreMemoryTextInformationKind.payloadSchema.parse(
        atom.payload,
      );
      return fragment(atom.informationId, "memory", payload.text);
    }
    throw new Error(`Unsupported reply context information kind: ${atom.kind}`);
  });
  return compiler.compile("reply", fragments);
}
```

`fragment` uses `id: informationId`, `informationId`, `priority: 20`, and empty JSON metadata. In the reply handler:

```ts
const contextAtoms = await context.select(
  dependencies.selector ?? currentAcceptedMessageSelector,
);
const persistedReply = requireSelectedReply(contextAtoms, reply.informationId);
const prompt = compileReplyPromptFromInformation(
  dependencies.promptCompiler ?? new PromptCompiler(),
  contextAtoms,
  reply.informationId,
);
await dependencies.executor.execute({
  reply: persistedReply,
  prompt,
  contextAtoms,
  selection: { modelTier: settings.modelTier },
  originatingModuleInstanceId: context.instanceId,
});
```

Construct default dependencies once in `createLlmReplyModule`, not once per message. Export public kind/selector/helper through `packages/modules/src/index.ts`, and update all touched headers.

- [ ] **Step 7: Verify Modules GREEN**

Run:

```bash
pnpm exec vitest run packages/modules/src/reply-context.test.ts packages/modules/src/information-modules.test.ts
pnpm --filter @kaguya/modules typecheck
```

Expected: default selection, ordered rendering, Memory references, unsupported-kind rejection, and reloaded-reply executor input all PASS.

- [ ] **Step 8: Commit module context behavior**

```bash
git add packages/modules/src/reply-context.ts packages/modules/src/reply-context.test.ts packages/modules/src/information-kinds.ts packages/modules/src/llm-reply.ts packages/modules/src/information-modules.test.ts packages/modules/src/index.ts
git commit -m "feat(modules): compile reply context from ledger atoms"
```

### Task 7: 持久化 LLM request 的有序 uses-context 引用

**Files:**

- Modify: `packages/runtime/src/information-kinds.ts:1-103`
- Modify: `packages/runtime/src/information-kinds.test.ts`
- Modify: `packages/runtime/src/llm-lifecycle.ts:1-188`
- Modify: `packages/runtime/src/llm-lifecycle.test.ts:1-283`
- Modify: `packages/runtime/src/runtime.ts:220-436`
- Modify: `packages/runtime/src/runtime.test.ts`
- Test: `packages/runtime/src/information-kinds.test.ts`
- Test: `packages/runtime/src/llm-lifecycle.test.ts`
- Test: `packages/runtime/src/runtime.test.ts`

**Interfaces:**

- Consumes: `LlmReplyExecutor` input containing `prompt` and ordered `contextAtoms`
- Changes: `LlmLifecycleRequest` includes ordered `contextAtoms`
- Produces: `core.llm.requested` with repeatable `core:uses-context`
- Preserves: completed/failed status links, provider error classification, model selection, and log redaction

- [ ] **Step 1: Write failing lifecycle trace tests**

Update the test Prompt to contain provenance for reply and Memory, register both atoms, and pass the same ordered `contextAtoms`. Assert the requested atom has exact references:

```ts
expect(requested.references).toEqual([
  { relation: "core:caused-by", informationId: fixture.reply.informationId },
  { relation: "core:context", informationId: fixture.context.informationId },
  {
    relation: "core:uses-context",
    informationId: fixture.memory.informationId,
  },
  { relation: "core:uses-context", informationId: fixture.reply.informationId },
]);
```

Add two rejection tests before provider invocation. Define a local `lifecycleRequest` helper that returns the complete existing request metadata, `reply: fixture.reply.payload`, the supplied Prompt, and supplied `contextAtoms`; it must not compute either expected order.

```ts
it("rejects Prompt provenance that differs from selected context order", async () => {
  const fixture = await createFixture(model);
  const prompt = tracedPrompt([
    fixture.reply.informationId,
    fixture.memory.informationId,
  ]);
  await expect(
    fixture.lifecycle.generate(
      lifecycleRequest(prompt, [fixture.memory, fixture.reply], fixture.reply),
      fixture.context,
      fixture.reply,
    ),
  ).rejects.toThrow("Prompt provenance must match selected information order");
  expect(await llmRequestedAtoms(fixture.database, fixture.context)).toEqual(
    [],
  );
});

it("rejects selected context that omits the caused-by reply", async () => {
  const fixture = await createFixture(model);
  const prompt = tracedPrompt([fixture.memory.informationId]);
  await expect(
    fixture.lifecycle.generate(
      lifecycleRequest(prompt, [fixture.memory], fixture.reply),
      fixture.context,
      fixture.reply,
    ),
  ).rejects.toThrow("Selected information must include the reply source");
  expect(await llmRequestedAtoms(fixture.database, fixture.context)).toEqual(
    [],
  );
});
```

`tracedPrompt` creates literal fragment/provenance entries in its input order; `llmRequestedAtoms` only queries real persisted atoms and filters `kind === "core.llm.requested"`. Neither helper may call production comparison or reference-building functions.

- [ ] **Step 2: Verify lifecycle RED**

Run:

```bash
pnpm exec vitest run packages/runtime/src/llm-lifecycle.test.ts -t "uses-context|provenance|omits"
```

Expected: FAIL because `core.llm.requested` does not declare or write `core:uses-context`, and lifecycle does not compare provenance.

- [ ] **Step 3: Add request reference rules and lifecycle validation**

Add to `llmRequestedInformationKind.references`:

```ts
"core:uses-context": {
  required: true,
  multiple: true,
},
```

Add `contextAtoms` to `LlmLifecycleRequest`. Before registering requested, derive dynamic provenance IDs and compare exact length, values, and order with `request.contextAtoms.map(atom => atom.informationId)`. Require `causedByAtom.informationId` in that list. Build request references from the same array:

```ts
references: [
  { relation: "core:caused-by", informationId: causedByAtom.informationId },
  { relation: "core:context", informationId: contextAtom.informationId },
  ...request.contextAtoms.map(({ informationId }) => ({
    relation: "core:uses-context" as const,
    informationId,
  })),
],
```

Do not copy `core:uses-context` to completed/failed atoms: those statuses already point to requested through `core:caused-by` and `core:status-of`, so the request remains the single provenance source.

- [ ] **Step 4: Write and verify the failing Runtime integration assertion**

In `runtime.test.ts`, submit one inbound message with the default modules, query atoms referencing the returned root, locate `core.reply.requested` and `core.llm.requested`, then assert:

```ts
expect(
  requested.references.filter(
    ({ relation }) => relation === "core:uses-context",
  ),
).toEqual([
  {
    relation: "core:uses-context",
    informationId: reply.informationId,
  },
]);
expect(requested.payload.prompt.provenance).toMatchObject([
  { informationId: reply.informationId, source: "history" },
]);
```

Run:

```bash
pnpm exec vitest run packages/runtime/src/runtime.test.ts -t "traces default reply Prompt"
```

Expected: FAIL because Runtime still constructs a fragment-free Prompt directly from `input.reply.payload.text`, so requested has neither provenance nor `core:uses-context`.

- [ ] **Step 5: Replace Runtime's direct Prompt construction**

In `#executeLlm`, keep the infrastructure-only lookup of the unique runtime context, but pass module-produced values through unchanged:

```ts
return lifecycle.generate(
  {
    kind: "reply",
    modelId: resolved.modelId,
    workflowId: "message-module-pipeline",
    nodeId: "reply",
    originatingModuleInstanceId: input.originatingModuleInstanceId,
    prompt: input.prompt,
    contextAtoms: input.contextAtoms,
    reply: input.reply.payload,
  },
  context as DeepReadonly<InformationAtom<"core.runtime.context">>,
  input.reply,
);
```

Delete the inline `{ text: input.reply.payload.text, fragments: [], provenance: [] }` construction. Update runtime unit fixtures for the expanded executor input.

- [ ] **Step 6: Verify Runtime GREEN with direct dependencies only**

Run:

```bash
pnpm exec vitest run packages/runtime/src/information-kinds.test.ts packages/runtime/src/llm-lifecycle.test.ts packages/runtime/src/runtime.test.ts
pnpm --filter @kaguya/runtime typecheck
```

Expected: all Runtime tests PASS; existing completed/failed lifecycle and delivery behavior remain green.

- [ ] **Step 7: Commit persisted Prompt provenance**

```bash
git add packages/runtime/src/information-kinds.ts packages/runtime/src/information-kinds.test.ts packages/runtime/src/llm-lifecycle.ts packages/runtime/src/llm-lifecycle.test.ts packages/runtime/src/runtime.ts packages/runtime/src/runtime.test.ts
git commit -m "feat(runtime): persist selected prompt context"
```

### Task 8: 完成架构约束、公开文档与全量交付验证

**Files:**

- Modify: `scripts/information-architecture.test.ts:1-200`
- Modify: `docs/developers/information-modules.md`
- Test: `scripts/information-architecture.test.ts`

**Interfaces:**

- Documents: `defineInformationSelector`, `context.select`, default current-message behavior, `core.memory.text`, and `core:uses-context`
- Enforces: no `sessionId` or `contextKey` in Memory/Prompt/reply production paths
- Verifies: all workspace packages, docs, and Web build after cross-package changes

- [ ] **Step 1: Add focused architecture rules and observe RED where applicable**

Extend the existing executable scanner with `sessionId` and `contextKey` rules scoped to these production paths:

```ts
const noImplicitContextPaths = [
  "packages/prompt/src/",
  "packages/modules/src/llm-reply.ts",
  "packages/modules/src/reply-context.ts",
  "packages/modules/src/information-kinds.ts",
] as const;
```

Add a pure helper test using a controlled source string containing both forbidden fields and assert literal violation messages. Also add a behavior check that the exported default Selector is invoked with a ledger whose three query methods throw and still returns only the source ID; keep this behavior test in `reply-context.test.ts`, not as a source-text grep.

Run:

```bash
pnpm exec vitest run scripts/information-architecture.test.ts -t "implicit context"
```

Expected: the new helper test fails until the scoped rules are implemented. Do not treat a violation from unrelated server request validation as RED; the scan must remain scoped to Memory/Prompt/reply production paths.

- [ ] **Step 2: Implement the scoped scan and update public documentation**

Implement path-aware forbidden rules without expanding them to server boundary tests that legitimately reject legacy request fields. Update `docs/developers/information-modules.md` after re-reading `docs/developers/markdown-features.md`. Explain in Chinese:

- Selector returns only ordered `informationId` values;
- `context.select` returns Core-loaded immutable atoms;
- query methods are `find`, `related`, and `retrieve`, with mandatory limits;
- unknown, duplicate, and unauthorized results fail;
- default reply selection contains only the current accepted message;
- Memory is `core.memory.text` and uses `core:uses-context`;
- no query automatically represents a Session or conversation history.

Use the existing `::: code-group` convention for a single TypeScript example and do not add a new page or sidebar entry.

- [ ] **Step 3: Verify the focused architecture and documentation radius**

Run:

```bash
pnpm exec vitest run scripts/information-architecture.test.ts packages/modules/src/reply-context.test.ts
pnpm exec prettier --check scripts/information-architecture.test.ts docs/developers/information-modules.md
git diff --check
```

Expected: scanner behavior and current workspace scan PASS; formatting and whitespace checks exit zero.

- [ ] **Step 4: Run the full delivery gate once**

Run each command separately and retain its exit code/output:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected:

- lint: zero errors;
- typecheck: all TypeScript project references and Web types pass;
- test: all test files pass with zero failed tests;
- build: workspace TypeScript and Web production build exit zero.

If any command fails, write the smallest regression test that reproduces the failure when it represents a behavior bug, then repeat RED→GREEN for that fix. Do not change tests merely to make the gate green.

- [ ] **Step 5: Perform the final requirements audit**

Read the spec and verify each acceptance item against committed tests and production paths:

```text
Prompt input IDs -> core.llm.requested core:uses-context + provenance
unknown ID      -> UnknownSelectedInformationIdError test
duplicate ID    -> DuplicateSelectedInformationIdError test
unauthorized ID -> UnauthorizedSelectedInformationIdError test
selection order -> Core + Prompt + persisted reference order tests
reference load  -> outgoing/incoming reader tests
missing atom    -> source/final/retrieval missing tests
concurrent read -> barrier isolation test
no session keys -> scoped architecture scan
default context -> no-query currentAcceptedMessageSelector test
```

Also inspect `git diff --check`, `git status --short`, and `git diff feat/issue-40-information-dag...HEAD --stat` to ensure only #41 changes are included.

- [ ] **Step 6: Commit docs and architecture enforcement**

```bash
git add scripts/information-architecture.test.ts docs/developers/information-modules.md
git commit -m "docs: explain explicit information selection"
```

- [ ] **Step 7: Re-run post-commit verification before claiming completion**

Because the final commit changes executable architecture tests and public docs, rerun:

```bash
pnpm exec vitest run scripts/information-architecture.test.ts
pnpm exec prettier --check docs/developers/information-modules.md scripts/information-architecture.test.ts
git diff --check HEAD^ HEAD
git status --short --branch
```

Expected: test and format checks pass, the committed diff has no whitespace errors, and the worktree is clean. Report the earlier full-gate counts and these fresh post-commit results without claiming #40 was modified or merged by this work.
