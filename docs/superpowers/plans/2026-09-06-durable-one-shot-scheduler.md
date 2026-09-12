# Durable One-Shot Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现一次性、绝对时间、可恢复的调度能力，使 schedule 在重启、重复 due delivery、replacement 与到期竞态下仍保持唯一业务终态。

**Architecture:** `@kaguya/scheduler` 定义 one-shot kinds、`kaguya:schedule.one-shot@1` capability、时钟、持久化端口和 timer runner；`@kaguya/database` 在同一 PostgreSQL 事务中保存不可变 schedule atom、arm projection、replacement 和唯一终态；`InformationCore` 负责 kind/reference 校验并把当前 durable claim 作为 fencing guard 传入。Runtime 在模块可靠订阅已登记后恢复 future/overdue arm，恢复完成后才开放 ingress；关闭时先停止 scheduler，再停止模块和可靠执行。

**Tech Stack:** TypeScript 6、Vitest 4、Zod、PostgreSQL/PGlite、现有 InformationCore/ModuleHost/Reliable DAG。

**Spec:** [GitHub Issue #80](https://github.com/posanbu/Kaguya/issues/80) 及其实现建议；上层边界见 [Epic #83](https://github.com/posanbu/Kaguya/issues/83)。

## Global Constraints

- 执行分支必须从 #82 的最终提交创建；该提交必须已经包含 #76/#79 的 `97d67c841dee9a596f575a16b29488a0890dc508`。
- #82 不是 scheduler 的运行时依赖；等待它完成仅为避免同时修改 `packages/runtime/src/runtime.ts`、Runtime composition 和 built-in kinds。
- capability ID 使用 SDK 允许的命名空间形式 `kaguya:schedule.one-shot`，`apiVersion` 为 `1`；它对应 Issue 中的 `kaguya.schedule.one-shot@1`。
- schedule 的 `informationId` 是唯一 work identity；`dueAt` 必须是带时区、可规范化为 UTC 的绝对 ISO 8601 时间。
- timer 只是可重建投影；不持久化 callback、闭包、调用栈或 Node timer handle。
- due atom 只登记一次，但它由 Reliable DAG at-least-once 投递；消费者必须通过唯一 schedule terminal 提交业务结果。
- replacement 必须在一个事务中创建新 schedule 并尝试 supersede 旧 schedule；旧 schedule 已有终态时，新输入仍创建独立 schedule。
- 正常 shutdown 不写 `cancelled`、`failed` 或其他业务终态；open schedule 保留供下次启动恢复。
- 首版只保证单 Runtime；不实现 lease、多 Runtime 协调、Cron、cadence、时区、DST、复杂 jitter、显式人工取消或人工重跑。
- 直接删除现有 `ManualTrigger`、`IntervalTrigger`、`CronTrigger` 及旧测试；不增加兼容 adapter、deprecated export 或内存 fallback。
- 所有新增或修改的源码文件保留中文架构头注释；公开文档只写中文，并明确标注尚未实现的 #81 cadence。

---

## Planned File Structure

**`packages/scheduler/src/information-kinds.ts`** — 定义 requested、due、fired、superseded、failed 五种通用 one-shot 信息及引用规则。

**`packages/scheduler/src/contracts.ts`** — 定义 capability、Core commit port、projection store、clock、timer API、receipt 和 terminal result。

**`packages/scheduler/src/client.ts`** — 实现模块可用的 `OneShotScheduleClient`，校验 absolute `dueAt`，调用 Core 原子操作。

**`packages/scheduler/src/runner.ts`** — 恢复 open projection、管理本地 timer、生成 overdue/future due；不包含任何聊天或 Agent 策略。

**`packages/scheduler/src/testing.ts`** — 提供确定性的 `FakeScheduleClock`，不依赖 Vitest fake timers。

**`packages/scheduler/src/index.ts`** — 只导出 durable one-shot 公共 API；删除旧 Trigger 实现。

**`packages/database/src/one-shot-schedule-repository.ts`** — PostgreSQL projection、原子 create/replace/due/terminal 操作。

**`packages/database/src/migrations.ts`** — 增加 `information_schedule_arms` 与 due 查询索引。

**`packages/engine/src/information-core.ts`** — 校验 schedule kinds/references，暴露受 claim fencing 保护的 one-shot commit port。

**`packages/runtime/src/runtime.ts`** — 装配 capability 与 runner，规定 start/close 顺序并在恢复完成前拒绝 ingress。

**`packages/database/src/one-shot-schedule-repository.test.ts`** — 事务、竞态和真实 PostgreSQL 验收。

**`packages/scheduler/src/runner.test.ts`** — fake clock、future/overdue、长 delay、stop 和重复 timer 回调测试。

**`packages/runtime/src/one-shot-scheduler.test.ts`** — synthetic debounce/wait consumer、重启和 Runtime 生命周期验收。

**`docs/developers/scheduler.md`** — 公开说明调度职责、状态流、at-least-once 边界和非目标；新增侧栏入口。

---

### Task 1: Replace the In-Memory Trigger API with Durable One-Shot Contracts

**Files:**

- Create: `packages/scheduler/src/contracts.ts`
- Create: `packages/scheduler/src/information-kinds.ts`
- Create: `packages/scheduler/src/client.ts`
- Modify: `packages/scheduler/src/index.ts`
- Modify: `packages/scheduler/package.json`
- Modify: `packages/scheduler/tsconfig.json`
- Test: `packages/scheduler/src/client.test.ts`
- Delete: `packages/scheduler/src/index.test.ts`

**Interfaces:**

- Consumes: `InformationId`, `JsonObject`, `InformationAtom`, `InformationReference`, `ModuleActivationProvenance`, `defineInformationKind`, `defineModuleCapability`。
- Produces:

```ts
export interface OneShotScheduleRequest {
  readonly operationKey: string;
  readonly sourceInformationId: InformationId;
  readonly dueAt: string;
  readonly input: JsonObject;
  readonly activation: ModuleActivationProvenance;
  readonly references?: readonly InformationReference[];
}

export interface OneShotScheduleReplacement extends OneShotScheduleRequest {
  readonly previousScheduleInformationId: InformationId;
}

export type OneShotScheduleReceipt = {
  readonly scheduleInformationId: InformationId;
  readonly created: boolean;
};

export type OneShotReplacementReceipt = OneShotScheduleReceipt & {
  readonly previousOutcome: "superseded" | "already-terminal";
  readonly previousTerminalInformationId: InformationId;
};

export interface OneShotTerminalResult {
  readonly scheduleInformationId: InformationId;
  readonly terminalInformationId: InformationId;
  readonly status: "fired" | "superseded" | "failed";
  readonly created: boolean;
}

export interface OneShotDueReceipt {
  readonly scheduleInformationId: InformationId;
  readonly dueInformationId: InformationId;
  readonly created: boolean;
}

export type OneShotTerminalRequest =
  | {
      readonly scheduleInformationId: InformationId;
      readonly status: "fired";
    }
  | {
      readonly scheduleInformationId: InformationId;
      readonly status: "failed";
      readonly failureKind: "consumer-failed" | "input-unavailable";
    };

export interface OneShotScheduleCapability {
  schedule(input: OneShotScheduleRequest): Promise<OneShotScheduleReceipt>;
  replace(
    input: OneShotScheduleReplacement,
  ): Promise<OneShotReplacementReceipt>;
  finish(input: OneShotTerminalRequest): Promise<OneShotTerminalResult>;
}

export interface OneShotFencingGuard {
  readonly subscriptionId: string;
  readonly informationId: InformationId;
  readonly token: string;
  readonly attempt: number;
  readonly leaseUntil: string;
  readonly signal?: AbortSignal;
}

export interface OneShotCreateCommit {
  readonly operationKey: string;
  readonly schedule: DeepReadonly<InformationAtom>;
  readonly dueAt: string;
  readonly guard?: OneShotFencingGuard;
}

export interface OneShotReplaceCommit {
  readonly operationKey: string;
  readonly previousScheduleInformationId: InformationId;
  readonly schedule: DeepReadonly<InformationAtom>;
  readonly superseded: DeepReadonly<InformationAtom>;
  readonly dueAt: string;
  readonly guard?: OneShotFencingGuard;
}

export interface OneShotDueCommit {
  readonly scheduleInformationId: InformationId;
  readonly due: DeepReadonly<InformationAtom>;
}

export interface OneShotTerminalCommit {
  readonly scheduleInformationId: InformationId;
  readonly terminal: DeepReadonly<InformationAtom>;
  readonly guard?: OneShotFencingGuard;
}

export const oneShotScheduleCapability =
  defineModuleCapability<OneShotScheduleCapability>(
    "kaguya:schedule.one-shot",
    1,
  );
```

- `OneShotScheduleCorePort` 固定暴露 `scheduleOneShot(input)`、`replaceOneShot(input)`、`finishOneShot(input)`，参数和返回值分别对应 capability 的 `schedule`、`replace`、`finish`；`OneShotScheduleClient` 只做代理和输入校验，不取得数据库或 timer。
- kinds 固定为 `core.schedule.one-shot.requested`、`core.schedule.one-shot.due`、`core.schedule.one-shot.fired`、`core.schedule.one-shot.superseded`、`core.schedule.one-shot.failed`。
- requested payload 保存规范 UTC `dueAt`、opaque `input`、activation；due payload 保存 `scheduleInformationId`、`dueAt`、`deliveredAt`；terminal 通过 `core:status-of` 指向 requested。

- [ ] **Step 1: 写 capability、时间格式和 kind schema 的失败测试**

```ts
it("publishes the v1 one-shot capability and rejects relative or timezone-free deadlines", async () => {
  expect(oneShotScheduleCapability).toMatchObject({
    id: "kaguya:schedule.one-shot",
    apiVersion: 1,
  });
  const core = { scheduleOneShot: vi.fn() };
  const client = new OneShotScheduleClient(core as never);
  await expect(
    client.schedule({ ...request, dueAt: "2026-09-06T12:00:00" }),
  ).rejects.toThrow(/absolute dueAt/);
  expect(core.scheduleOneShot).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 运行测试确认旧 Trigger API 无法满足新契约**

Run: `pnpm exec vitest run packages/scheduler/src/client.test.ts --maxWorkers=1`

Expected: FAIL，缺少 `oneShotScheduleCapability`、`OneShotScheduleClient` 和信息 kind。

- [ ] **Step 3: 定义严格 schema 和规范化规则**

```ts
export function normalizeDueAt(value: string): string {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(value))
    throw new Error("one-shot schedule requires an absolute dueAt");
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) throw new Error("invalid one-shot dueAt");
  return new Date(epoch).toISOString();
}
```

requested 必须有一条 `core:caused-by`；replacement 新 schedule 增加一条 `core:replaces`；due 和三个 terminal 各有一条 `core:status-of` 指向 requested。`input` 使用严格 `JsonObject` schema，不允许 scheduler 解释其字段。

- [ ] **Step 4: 实现 capability client 并删除旧 Trigger exports**

`schedule`、`replace`、`finish` 先解析完整输入，再调用 Core port；所有错误原样传播，不把存储错误改写成业务 `failed`。从 `index.ts` 删除 `Trigger`、`ManualTrigger`、`IntervalTrigger`、`CronTrigger`、timer API 和 Cron 解析器。

- [ ] **Step 5: 运行 scheduler 测试与类型检查**

Run: `pnpm exec vitest run packages/scheduler/src/client.test.ts --maxWorkers=1 && pnpm --filter @kaguya/scheduler typecheck`

Expected: PASS；`rg -n 'ManualTrigger|IntervalTrigger|CronTrigger|interface Trigger' packages apps` 无结果。

- [ ] **Step 6: 提交公共契约**

```bash
git add packages/scheduler
git commit -m "feat(scheduler): define durable one-shot contract"
```

---

### Task 2: Persist Arm Projection and Atomic Schedule State Changes

**Files:**

- Create: `packages/database/src/one-shot-schedule-repository.ts`
- Create: `packages/database/src/one-shot-schedule-repository.test.ts`
- Modify: `packages/database/src/information-repository.ts`
- Modify: `packages/database/src/reliable-repository.ts`
- Modify: `packages/database/src/migrations.ts`
- Modify: `packages/database/src/index.ts`
- Modify: `packages/database/package.json`
- Modify: `packages/database/tsconfig.json`
- Test: `packages/database/src/postgres-reliable.test.ts`

**Interfaces:**

- Consumes: Task 1 kinds and request/result types；现有 `appendInformationAtom`、`InformationClaim` fencing、operation/terminal slots。
- Produces:

```ts
export interface OpenOneShotArm {
  readonly scheduleInformationId: InformationId;
  readonly dueAt: string;
}

export interface OpenOneShotPage {
  readonly arms: readonly OpenOneShotArm[];
  readonly nextCursor?: InformationId;
}

export interface OneShotScheduleProjectionStore {
  create(input: OneShotCreateCommit): Promise<OneShotScheduleReceipt>;
  replace(input: OneShotReplaceCommit): Promise<OneShotReplacementReceipt>;
  emitDue(input: OneShotDueCommit): Promise<OneShotDueReceipt>;
  finish(input: OneShotTerminalCommit): Promise<OneShotTerminalResult>;
  listOpen(input: {
    readonly after?: InformationId;
    readonly limit: number;
  }): Promise<OpenOneShotPage>;
}
```

- `InformationRepository` 增加必选 `readonly oneShotSchedules: OneShotScheduleProjectionStore`；不把 scheduler 方法混入 Reliable DAG 的 claim/ack API。
- 新表：

```sql
CREATE TABLE information_schedule_arms (
  schedule_information_id text PRIMARY KEY
    REFERENCES information_atoms(information_id) ON DELETE RESTRICT,
  due_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('open', 'due', 'terminal')),
  due_information_id text UNIQUE
    REFERENCES information_atoms(information_id) DEFERRABLE INITIALLY DEFERRED,
  terminal_information_id text UNIQUE
    REFERENCES information_atoms(information_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX information_schedule_arms_open_due_idx
  ON information_schedule_arms(due_at, schedule_information_id)
  WHERE state = 'open';
```

- [ ] **Step 1: 写事务和唯一性失败测试**

覆盖 create 原子写 atom+arm、相同 operationKey 返回同一 schedule、replace 原子写新 atom+arm+旧 superseded、旧 terminal 已存在时仍创建新 schedule、fired/replace 并发只有一个旧 terminal 赢家、任一 SQL 故障整笔回滚、旧 claim 在 lease 失效后不能 replace/finish。

```ts
const [fired, replacement] = await Promise.all([
  repo.finish(firedCommit(oldSchedule)),
  repo.replace(replaceCommit(oldSchedule, newSchedule)),
]);
const terminals = await statusAtoms(oldSchedule.informationId);
expect(terminals).toHaveLength(1);
expect([fired.created, replacement.previousOutcome]).toSatisfy(
  ([created, outcome]) =>
    (created && outcome === "already-terminal") ||
    (!created && outcome === "superseded"),
);
expect(await repo.get(newSchedule.informationId)).toBeDefined();
```

- [ ] **Step 2: 运行 PGlite 测试确认 projection 尚不存在**

Run: `pnpm exec vitest run packages/database/src/one-shot-schedule-repository.test.ts --maxWorkers=1`

Expected: FAIL，migration 表和 `oneShotSchedules` port 缺失。

- [ ] **Step 3: 添加 schema version 5 migration**

将 `POSTGRES_SCHEMA_VERSION` 从 `4` 改为 `5`，幂等创建 projection 表和 partial index。保持 information atoms/references 的 append-only trigger 不变；projection 是可变执行状态，不对它安装 append-only trigger。

- [ ] **Step 4: 实现 create 和分页恢复查询**

`create` 在事务中先占用现有 operation slot，再调用共享 append helper，随后插入 arm；冲突时读取槽中的实际赢家。`listOpen` 使用 `(schedule_information_id > cursor)` 的稳定 keyset pagination，`ORDER BY schedule_information_id LIMIT $n`，每页默认由 runner 传入 `256`。

- [ ] **Step 5: 实现 replace、emitDue 和 finish 的原子竞态**

每个操作先 `SELECT ... FOR UPDATE` 锁旧 arm，并读取 schedule terminal slot：

- replace 总是先创建新 schedule；旧 terminal 不存在时同事务提交 superseded 并把旧 arm 设为 terminal。
- 旧 terminal 已存在时返回 `already-terminal`，不改旧 terminal，新 schedule 保持 open。
- emitDue 通过固定 operation namespace `kaguya.schedule.one-shot.due.v1` 和旧 schedule ID 去重，成功后把 arm 设为 due；due 本身不是 terminal，若 replacement 随后获胜，迟到 consumer 的 fired 提交必须返回 superseded 赢家。
- finish 使用 terminal group `kaguya.schedule.one-shot.result.v1`；fired、failed、superseded 共用 subject schedule ID，实际返回持久化赢家。
- 所有写方法在 `BEGIN` 后和 `COMMIT` 前检查 claim signal/token，沿用 `InformationClaimLostError`。

- [ ] **Step 6: 用 12 个真实 PostgreSQL 连接验证 race**

Run: `KAGUYA_REQUIRE_POSTGRES_TESTS=1 KAGUYA_TEST_DATABASE_URL="$KAGUYA_TEST_DATABASE_URL" pnpm exec vitest run packages/database/src/one-shot-schedule-repository.test.ts packages/database/src/postgres-reliable.test.ts --maxWorkers=1`

Expected: PASS；并发 replacement/due、关闭重连后的 open projection 和 fencing 均通过。

- [ ] **Step 7: 提交持久化层**

```bash
git add packages/database
git commit -m "feat(database): persist one-shot schedule arms"
```

---

### Task 3: Implement Core Fencing, Host Clock, and the Timer Runner

**Files:**

- Create: `packages/scheduler/src/runner.ts`
- Create: `packages/scheduler/src/runner.test.ts`
- Create: `packages/scheduler/src/testing.ts`
- Modify: `packages/scheduler/src/contracts.ts`
- Modify: `packages/scheduler/src/index.ts`
- Modify: `packages/scheduler/package.json`
- Modify: `packages/scheduler/tsconfig.json`
- Modify: `packages/engine/src/information-core.ts`
- Modify: `packages/engine/src/index.ts`
- Modify: `packages/engine/package.json`
- Modify: `packages/engine/tsconfig.json`
- Test: `packages/engine/src/information-core.test.ts`

**Interfaces:**

- Consumes: Task 2 `OneShotScheduleProjectionStore` and current Core AsyncLocalStorage claim context。
- Produces:

```ts
export interface ScheduleClock {
  now(): Date;
  setTimeout(handler: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DurableOneShotSchedulerOptions {
  readonly store: OneShotScheduleProjectionStore;
  readonly clock?: ScheduleClock;
  readonly nextInformationId: () => InformationId;
  readonly recoveryBatchSize?: number;
  readonly drainTimeoutMs?: number;
}

export class DurableOneShotScheduler {
  start(): Promise<void>;
  stop(): Promise<void>;
  refresh(scheduleInformationId: InformationId): Promise<void>;
}

export class FakeScheduleClock implements ScheduleClock {
  now(): Date;
  advanceTo(target: Date): Promise<void>;
  pendingTimerCount(): number;
}
```

- `InformationCore` 实现 `OneShotScheduleCorePort`：`scheduleOneShot`、`replaceOneShot`、`finishOneShot`。所有入口复用 Registry/reference validation，并把 `#execution` 中当前 claim 传给 store；若在 durable handler 内调用，丢失 lease 后提交失败。

- [ ] **Step 1: 写 fake clock 和 runner 失败测试**

```ts
it("restores future and overdue arms before start resolves", async () => {
  const clock = new FakeScheduleClock("2026-09-06T12:00:00.000Z");
  const store = fixtureStore([
    arm("future", "2026-09-06T12:01:00.000Z"),
    arm("overdue", "2026-09-06T11:59:00.000Z"),
  ]);
  const scheduler = new DurableOneShotScheduler({
    store,
    clock,
    nextInformationId,
    recoveryBatchSize: 1,
  });
  await scheduler.start();
  expect(store.emitDue).toHaveBeenCalledWith(
    expect.objectContaining({ scheduleInformationId: "overdue" }),
  );
  expect(clock.pendingTimerCount()).toBe(1);
});
```

另测重复 timer callback 只调用同一个 idempotent due operation、超过 `2_147_483_647` ms 的 delay 分段 re-arm、`stop()` 后 timer 数为 0、正在执行的 callback 有界排空、stop 不调用 finish。

- [ ] **Step 2: 运行测试确认 runner 和 fake clock 缺失**

Run: `pnpm exec vitest run packages/scheduler/src/runner.test.ts packages/engine/src/information-core.test.ts --maxWorkers=1`

Expected: FAIL，缺少 runner/clock/Core port。

- [ ] **Step 3: 实现可注入 clock 与确定性 fake clock**

system clock 包装 `Date`、`setTimeout`、`clearTimeout`；fake clock 按 deadline 和插入序号稳定排序，同一时间点逐个执行并等待 microtask，测试不调用 `vi.useFakeTimers()`。

- [ ] **Step 4: 实现分页恢复和 timer 生命周期**

`start` 分页读完所有 open arms；overdue 立即调用 `emitDue`，future 按绝对 `dueAt - clock.now()` arm。`refresh` 用于 capability 新建/replace 后在当前进程注册 timer。timer 触发时重新比较绝对时间，时钟倒退则重新 arm；长 delay 按 Node 最大 timeout 分段。

- [ ] **Step 5: 实现 stop 的顺序和有界排空**

`stop` 先拒绝 `refresh`，再清除全部 timer，最后按 `drainTimeoutMs` 等待当前 emitDue。无论排空超时还是 callback 失败，都不改变 arm 的业务状态；迟到 callback 依靠 store operation slot 和 runner generation 防止重启后重复产生新 due atom。

- [ ] **Step 6: 把 Core 接到 projection store 并验证 fencing**

给 `InformationLedger` 增加可选 `readonly oneShotSchedules?: OneShotScheduleProjectionStore`，保持不支持调度的内存 ledger fixture 可用；调用 schedule 方法时若 port 缺失则明确失败。schedule 方法用当前 claim 构造 guard。新增测试让旧 claim 在 gated transaction 中过期，断言 schedule atom、arm 和 terminal 都未提交。

- [ ] **Step 7: 运行聚焦测试与类型检查**

Run: `pnpm exec vitest run packages/scheduler/src/runner.test.ts packages/engine/src/information-core.test.ts packages/database/src/one-shot-schedule-repository.test.ts --maxWorkers=1 && pnpm --filter @kaguya/scheduler typecheck && pnpm --filter @kaguya/engine typecheck`

Expected: PASS。

- [ ] **Step 8: 提交 runner 与 Core seam**

```bash
git add packages/scheduler packages/engine
git commit -m "feat(scheduler): recover and deliver one-shot deadlines"
```

---

### Task 4: Wire Runtime Lifecycle and Prove Synthetic Debounce/Wait Recovery

**Files:**

- Create: `packages/runtime/src/one-shot-scheduler.test.ts`
- Modify: `packages/runtime/src/runtime.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify: `packages/runtime/package.json`
- Modify: `packages/runtime/tsconfig.json`
- Modify: `apps/server/src/runtime-composition.ts`
- Modify: `apps/demo/src/runtime-composition.ts`
- Test: `apps/server/src/server-composition.test.ts`

**Interfaces:**

- Consumes: Task 1 capability/client、Task 3 runner、#82 最终的 `RuntimeCapabilityContext` 和 model-task composition。
- Produces: `RuntimeCapabilityContext.oneShotSchedule: OneShotScheduleCapability`；apps composition 将 `{ capability: oneShotScheduleCapability, value: oneShotSchedule }` 与 model-task capability 一次性返回。

- [ ] **Step 1: 写 Runtime 启动/关闭顺序失败测试**

```ts
it("does not accept ingress until overdue schedule recovery completes", async () => {
  const recovery = deferred<void>();
  const runtime = createRuntime({ oneShotRecoveryGate: recovery.promise });
  const starting = runtime.start();
  await recovery.entered;
  await expect(runtime.submit(webMessage())).rejects.toThrow(
    RuntimeUnavailableError,
  );
  recovery.resolve();
  await starting;
});
```

另测 `close()` 先停止 scheduler，再停止 ModuleHost/Reliable runner；挂起 due callback 按 Runtime `drainTimeoutMs` 有界结束；open arm 重启后仍恢复，stop 不产生 terminal。

- [ ] **Step 2: 写 synthetic debounce/wait 端到端失败测试**

定义测试模块 `test.schedule.synthetic`：

- 消费 `test.input` 后调用 `schedule()` 表示 wait。
- 第二个输入调用 `replace()`，新 schedule 的 opaque input 同时保存两条 input ID，模拟 debounce 合并。
- durable 消费 `core.schedule.one-shot.due`，读取 requested input，调用 `finish({status: "fired"})`。
- consumer 不导入 Heartbeat、Heartflow、Speaking 或 Model Task。

关闭第一个 Runtime、保留数据库和 fake clock、启动第二个 Runtime并越过 deadline；断言只消费 replacement schedule，旧 schedule 为 superseded，新 schedule 为 fired，两条输入均存在于新 schedule，重复 due delivery 不增加 terminal。

- [ ] **Step 3: 运行测试确认 Runtime 尚未装配 scheduler**

Run: `pnpm exec vitest run packages/runtime/src/one-shot-scheduler.test.ts apps/server/src/server-composition.test.ts --maxWorkers=1`

Expected: FAIL，缺少 `RuntimeCapabilityContext.oneShotSchedule`、runner 生命周期和 built-in schedule kinds。

- [ ] **Step 4: 注册 built-in kinds 并装配 capability**

在 Runtime 建 Registry 时加入五种 schedule kinds。创建 `OneShotScheduleClient(core)` 和 `DurableOneShotScheduler(database.information.oneShotSchedules, clock)`；把 client 放入 capability factory context。若 apps composition 重复提供 `kaguya:schedule.one-shot@1`，ModuleHost 预检应明确拒绝重复 provider。

- [ ] **Step 5: 实现严格生命周期顺序**

启动顺序固定为：database migrate → Core start → ModuleHost 注册 durable subscriptions 并启动 Reliable runner → scheduler 完成 open-arm 恢复 → Runtime 置 `started`。关闭顺序固定为：Runtime 置 `closing` → scheduler stop/clear timers → ModuleHost stop → Core close → 自有 database close。

- [ ] **Step 6: 合并 #82 composition 改动一次**

从 #82 最终文件形态修改 server/demo capability factory，不恢复 reply-only `LlmLifecycleClient` 或 `LlmReplyExecutor`。scheduler capability 与 `modelTaskCapability` 并列提供，两者互不调用。

- [ ] **Step 7: 运行 Runtime、server、demo 聚焦测试**

Run: `pnpm exec vitest run packages/runtime/src/one-shot-scheduler.test.ts packages/runtime/src/runtime.test.ts packages/runtime/src/model-task.test.ts apps/server/src/server-composition.test.ts --maxWorkers=1`

Expected: PASS；synthetic consumer 不启动任何 Agent 上层模块。

- [ ] **Step 8: 提交 Runtime 集成**

```bash
git add packages/runtime apps/server apps/demo
git commit -m "feat(runtime): wire durable one-shot scheduling"
```

---

### Task 5: Complete Real PostgreSQL Acceptance, Documentation, and Removal Audit

**Files:**

- Modify: `packages/database/src/postgres-reliable.test.ts`
- Modify: `packages/runtime/src/one-shot-scheduler.test.ts`
- Create: `docs/developers/scheduler.md`
- Modify: `docs/.vitepress/sidebar.ts`
- Modify: `docs/developers/index.md`
- Modify: `docs/developers/information-modules.md`

**Interfaces:**

- Consumes: Tasks 1–4 的最终 API，无新增生产接口。
- Produces: #80 最小验收证据和公开架构说明。

- [ ] **Step 1: 补齐真实 PostgreSQL 崩溃窗口测试**

用独立连接和同一数据库覆盖：requested+arm 提交后退出、overdue 启动恢复、due atom 提交后到 durable ack 前退出、terminal 提交后到 ack 前退出。每个窗口重启后断言 schedule ID、due ID、terminal ID 均稳定，consumer 的账本业务输出只出现一次；外部副作用仍只有 at-least-once 保证。

- [ ] **Step 2: 验证 replacement/due 竞态不丢输入**

使用 barrier 同时释放 12 个连接：一半调用 replace，一半触发 due/finish。断言旧 schedule 只有一个 terminal；若 superseded 赢，新 schedule input 含旧、新 input ID；若 fired 赢，新 input 仍有独立 open/new schedule。任何结果都不得只保留“最新文本”而丢失旧 input identity。

- [ ] **Step 3: 写调度器公开文档**

文档明确说明：schedule atom 是意图、arm 是 projection、due 为 at-least-once、terminal 唯一；展示 `schedule/replace/finish` 模块代码组；列出 shutdown、重启、过期 schedule 行为；说明 #81 cadence/Cron 仍在规划中。更新 sidebar 和开发者包地图，删除旧 Manual/Interval/Cron 描述。

- [ ] **Step 4: 执行旧 API 与越界依赖审计**

Run: `rg -n 'ManualTrigger|IntervalTrigger|CronTrigger|callback.*persist|setInterval' packages apps docs -g '*.ts' -g '*.md'`

Expected: scheduler 旧 API 无结果；仅 Reliable runner 或与 one-shot 无关的明确基础设施 timer 可以保留。再运行：

Run: `rg -n 'heartbeat|turn candidate|speaking|chat scope|debounce' packages/scheduler packages/database/src/one-shot-schedule-repository.ts`

Expected: 生产代码无结果；这些词只允许出现在验收测试描述或公开边界文档中。

- [ ] **Step 5: 运行完整验证**

Run: `pnpm typecheck && pnpm lint && pnpm exec prettier --check .`

Run: `KAGUYA_REQUIRE_POSTGRES_TESTS=1 KAGUYA_TEST_DATABASE_URL="$KAGUYA_TEST_DATABASE_URL" pnpm exec vitest run --maxWorkers=1`

Run: `pnpm --dir docs docs:check`

Expected: 全部退出码为 0；PostgreSQL 套件不得 skip；VitePress 无 broken link。

- [ ] **Step 6: 复核验收映射**

逐项确认：future/overdue 重启恢复、replacement 原子性、due/replacement 唯一终态、重复 due delivery 唯一业务结果、ingress readiness、stop 无残留 timer 且不写业务 terminal、synthetic consumer 不启动 Heartbeat。确认非目标没有进入公共 API。

- [ ] **Step 7: 提交验收和文档**

```bash
git add packages/database/src/postgres-reliable.test.ts \
  packages/runtime/src/one-shot-scheduler.test.ts \
  docs/developers/scheduler.md \
  docs/.vitepress/sidebar.ts \
  docs/developers/index.md \
  docs/developers/information-modules.md
git commit -m "docs: document durable one-shot scheduling"
```

---

## Execution Order and #82 Coordination

不要在 #82 仍修改共享文件时开始 Task 4。安全顺序如下：

1. 等 #82 完成所有实现、审查和统一验证，取得其最终 commit SHA。
2. 从 #82 最终 SHA 创建 `feat/issue-80` worktree；确认它包含 #76/#79 commit。
3. Task 1–3 可以连续执行；它们不修改 #82 的 model-task 文件，但必须基于 #82 的最终树。
4. Task 4 只在该基线上修改一次 Runtime 和 apps composition，保留 #82 的通用 Model Task 路径。
5. Task 5 做真实 PostgreSQL 与整仓验收，再交独立 reviewer 检查 scheduler 边界、事务竞态和生命周期。

不建议现在另开一个直接编码的 #80 session：虽然 scheduler/database 文件大多独立，但最终接口会影响 Runtime、built-in kinds、package references 和 composition；先让 #82 收口可避免重复 cherry-pick 和冲突修复。当前可以只审阅本计划，不写生产代码。
