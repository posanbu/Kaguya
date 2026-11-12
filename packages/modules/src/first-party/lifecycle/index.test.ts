/**
 * 功能概述：通过真实 Core、ModuleHost、Scheduler 与 PGlite 验证 Lifecycle 状态、调度和观察恢复。
 * 碰撞回归以相同旧 scope 的不同 scene 验证 legacy defer、启动/到期恢复与候选开放槽隔离。
 * 主要职责：fixture 提供合成时钟、入站与手动 due；settle 等待持久队列并报告处理错误。
 * restart 关闭原 core/runner 后重建宿主和绑定能力，保留数据库、订阅 ID、时钟与 ID 序列。
 * 代码库关系：直接运行 createLifecycleModule，覆盖离线期间多人消息及无新入站的启动恢复。
 * seedOpenOwners 在同一事务写入 1000 条无关调度的完整关联，两端真实调度验证分页及原 deadline。
 * lifecycleTest 按每例设置、操作、8 秒收敛和断言合计正文预算；不改变全局或业务 deadline。
 * withDiagnostics/step 记录全 fixture 操作与收敛的起止，失败时输出冻结的阶段、队列和 handler 错误。
 * 默认完整文件使用 PGlite；提供测试 PostgreSQL URL 时另运行同一超页场景，验证批量 SQL 与恢复路径。
 * 资源取得后立即登记清理；启动拒绝或 stop 失败时仍顺序释放全部资源并汇总错误。
 * 输入输出与副作用：每例独立数据库，8 秒/20 毫秒条件等待；结束关闭 host/core/数据库，不请求外部服务。
 */
import { closeTestResources } from "../test-support/cleanup.js";
import { observationCapability } from "@kaguya/sdk";
import { afterEach, expect, it, vi, type TestContext } from "vitest";
import type { KaguyaDatabase } from "@kaguya/database";
import {
  createTestingDatabase,
  createPostgresTestingDatabase,
} from "@kaguya/database/testing";
import {
  InformationCore,
  InformationKindRegistry,
  ModuleHost,
} from "@kaguya/engine";
import {
  catalogInformationKinds,
  defineInformationKind,
  defineInformationModuleCatalog,
} from "@kaguya/sdk";
import {
  informationAtomSchema,
  z,
  sceneIdentity,
  type SceneAddress,
} from "@kaguya/schema";
import {
  OneShotScheduleClient,
  oneShotDueInformationKind,
  oneShotRequestedInformationKind,
  oneShotScheduleCapability,
} from "@kaguya/scheduler";
import { createLifecycleModule, lifecycleSettingsSchema } from "./index.js";
import {
  lifecycleStartedInformationKind,
  lifecycleStartupCapability,
} from "./pulse.js";
import {
  inboundTextInformationKind,
  attentionArousalStateRecordedInformationKind,
} from "../information-kinds.js";

const clean: Array<() => Promise<void>> = [];
const persistenceWait = { timeout: 8000, interval: 20 } as const;
// 外层正文预算的分项，不是各阶段新增 deadline；afterEach 使用独立 hook 预算。
const paginationBudget = {
  schema: 10_000, // PGlite/PG 连接、schema 和 Core 初始化
  seed: 5_000, // 批量事务、两端真实调度及 1000+2 分页断言
  start: 2_000 + persistenceWait.timeout,
  restart: 5_000 + persistenceWait.timeout, // 包含旧 Host/Core 关闭和重新装配
  due1: 2_000 + persistenceWait.timeout,
  due2: 2_000 + persistenceWait.timeout,
  assertions: 2_000,
} as const;
// 普通例以实际操作次数组成总预算；分项仅供求和与诊断，不施加阶段 deadline。
function ordinaryBudget(counts: {
  due?: number;
  inbound?: number;
  startup?: number;
  settle?: number;
  register?: number;
  replace?: number;
  stop?: number;
  restart?: number;
}) {
  return {
    schema: 10_000,
    start: 2_000 + persistenceWait.timeout,
    due: (counts.due ?? 0) * (2_000 + persistenceWait.timeout),
    inbound: (counts.inbound ?? 0) * (2_000 + persistenceWait.timeout),
    startup: (counts.startup ?? 0) * (2_000 + persistenceWait.timeout),
    settle: (counts.settle ?? 0) * persistenceWait.timeout,
    register: (counts.register ?? 0) * 2_000,
    replace: (counts.replace ?? 0) * 2_000,
    stop: (counts.stop ?? 0) * 2_000,
    restart: (counts.restart ?? 0) * (5_000 + persistenceWait.timeout),
    assertions: 2_000,
  };
}
type BodyBudget = Record<string, number>;
const bodyTimeout = (budget: BodyBudget) =>
  Object.values(budget).reduce((total, ms) => total + ms, 0);

function createDiagnostics(
  context: TestContext,
  budget: BodyBudget,
  backend: string,
) {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const stages: {
    name: string;
    startedAtMs: number;
    finishedAtMs?: number;
    outcome?: "passed" | "failed";
    error?: string;
  }[] = [];
  const active: string[] = [];
  const handlerErrors: string[] = [];
  let assertionPhase = { name: "test body before fixture", startedAtMs: 0 };
  let failedStage: string | undefined;
  let lastHealth: unknown;
  let snapshot: unknown;
  const finish = () => {
    snapshot ??= {
      backend,
      bodyElapsedMs: elapsed(),
      bodyTimeoutMs: bodyTimeout(budget),
      bodyBudgetMs: budget,
      aborted: context.signal.aborted,
      abortReason: context.signal.aborted
        ? String(context.signal.reason)
        : undefined,
      failedStage,
      unfinishedStages: [...active],
      assertionPhase: {
        ...assertionPhase,
        finishedAtMs: active.length ? undefined : elapsed(),
      },
      stages: stages.map((stage) => ({ ...stage })),
      lastHealth,
      handlerErrors: [...handlerErrors],
    };
  };
  context.signal.addEventListener("abort", finish, { once: true });
  context.onTestFailed(() => {
    console.error("Lifecycle fixture diagnostics", JSON.stringify(snapshot));
  });
  return {
    async step<T>(name: string, run: () => T | Promise<T>): Promise<T> {
      const stage = { name, startedAtMs: elapsed() } as (typeof stages)[number];
      if (!snapshot) {
        if (!active.length)
          stages.push({
            ...assertionPhase,
            finishedAtMs: stage.startedAtMs,
            outcome: "passed",
          });
        stages.push(stage);
        active.push(name);
      }
      try {
        const result = await run();
        if (!snapshot) stage.outcome = "passed";
        return result;
      } catch (error) {
        if (!snapshot) {
          stage.outcome = "failed";
          stage.error = String(error);
          failedStage ??= name;
        }
        throw error;
      } finally {
        if (!snapshot) {
          stage.finishedAtMs = elapsed();
          active.pop();
          if (!active.length)
            assertionPhase = {
              name: `assertions after ${name}`,
              startedAtMs: elapsed(),
            };
        }
      }
    },
    health(value: unknown) {
      if (!snapshot)
        lastHealth = { atMs: elapsed(), stage: active.at(-1), value };
    },
    handlerError(error: unknown) {
      if (!snapshot) handlerErrors.push(String(error));
    },
    bodyError() {
      if (!snapshot) failedStage ??= assertionPhase.name;
    },
    finish() {
      finish();
      context.signal.removeEventListener("abort", finish);
    },
  };
}
type Diagnostics = ReturnType<typeof createDiagnostics>;
async function withDiagnostics(
  context: TestContext,
  budget: BodyBudget,
  backend: string,
  run: (diagnostics: Diagnostics) => Promise<void>,
) {
  const diagnostics = createDiagnostics(context, budget, backend);
  try {
    await run(diagnostics);
  } catch (error) {
    diagnostics.bodyError();
    throw error;
  } finally {
    diagnostics.finish();
  }
}
function lifecycleTest(
  name: string,
  counts: Parameters<typeof ordinaryBudget>[0],
  run: (diagnostics: Diagnostics) => Promise<void>,
) {
  const budget = ordinaryBudget(counts);
  it(name, { timeout: bodyTimeout(budget) }, (context) =>
    withDiagnostics(context, budget, "PGlite", run),
  );
}
afterEach(async () => {
  await closeTestResources(clean);
});
const runtimeContext = defineInformationKind({
  kind: "core.runtime.context",
  displayName: "test",
  description: "test",
  payloadSchema: z.object({}).strict(),
  references: {},
  log: { enabled: false },
});
const taskRequested = defineInformationKind({
  kind: "core.model.task.requested",
  displayName: "test",
  description: "test",
  payloadSchema: z.object({}).strict(),
  references: {},
  log: { enabled: false },
});
const taskCompleted = defineInformationKind({
  kind: "core.model.task.completed",
  displayName: "test",
  description: "test",
  payloadSchema: z.object({}).strict(),
  references: { "core:status-of": { required: true, multiple: false } },
  log: { enabled: false },
});
async function fixture(
  diagnostics: Diagnostics,
  beforeStart?: (seed: {
    db: KaguyaDatabase;
    core: InformationCore;
    scheduler: OneShotScheduleClient;
    inbound: (
      direct: boolean,
      senderId?: string,
      wait?: boolean,
      address?: SceneAddress,
    ) => Promise<{ informationId: string }>;
    now: () => Date;
  }) => Promise<void>,
  createDatabase: () => Promise<KaguyaDatabase> = createTestingDatabase,
) {
  const db = await diagnostics.step("database.connect", createDatabase);
  clean.push(() => db.close());
  await diagnostics.step("database.prepareSchema", () => db.prepareSchema());
  const failures: unknown[] = [];
  const definition = createLifecycleModule({ timeZone: "Asia/Shanghai" });
  const catalog = defineInformationModuleCatalog({
    ...definition,
    create: async (options, ctx) => {
      const instance = await definition.create(options, ctx);
      return {
        ...instance,
        subscriptions: instance.subscriptions.map((subscription) => ({
          ...subscription,
          handle: async (atom, context) => {
            try {
              await subscription.handle(atom, context);
            } catch (error) {
              failures.push(error);
              diagnostics.handlerError(error);
              throw error;
            }
          },
        })),
      };
    },
  });
  const registry = new InformationKindRegistry();
  for (const kind of [
    ...catalogInformationKinds(catalog),
    runtimeContext,
    taskRequested,
    taskCompleted,
  ].filter((k) => !k.kind.startsWith("core.schedule.")))
    kind.kind.startsWith("core.")
      ? registry.registerBuiltin(kind)
      : registry.register(kind);
  let n = 0;
  let time = Date.UTC(2026, 9, 22);
  const now = () => new Date(time);
  const makeCore = () =>
    new InformationCore({
      registry,
      store: db.information,
      now,
      nextInformationId: () => `lifecycle-${String(++n).padStart(6, "0")}`,
    });
  let core = makeCore();
  clean.push(() => core.close());
  let scheduler = new OneShotScheduleClient(core);
  const start = async (instanceId: string) => {
    await diagnostics.step("startup.register", () =>
      core.register(lifecycleStartedInformationKind, {
        occurredAt: now().toISOString(),
        source: "module:test",
        payload: { instanceId, at: now().toISOString() },
        references: [],
      }),
    );
  };
  const makeHost = () =>
    new ModuleHost({
      core,
      catalog,
      now,
      capabilities: [
        { capability: observationCapability, value: db.observations },
        { capability: oneShotScheduleCapability, value: scheduler },
        { capability: lifecycleStartupCapability, value: { start } },
      ],
    });
  let host = makeHost();
  clean.push(() => host.stop());
  await diagnostics.step("core.start", () => core.start());

  const settle = (name = "explicit.settle") =>
    diagnostics.step(name, () =>
      vi.waitFor(async () => {
        const health = await db.information.reliable.health();
        diagnostics.health(health);
        if (failures.length) throw failures[0];
        expect(health.pending).toBe(0);
        expect(health.exhausted).toBe(0);
      }, persistenceWait),
    );
  const all = (kind: string) =>
    diagnostics.step(`read:${kind}`, () =>
      db.information.find({
        kinds: [kind],
        registrationOrder: true,
        order: "desc",
        limit: 1000,
      }),
    );
  const state = async () =>
    (await all("agent.lifecycle.state.recorded"))[0]!.payload;
  const timers = async (purpose: string) =>
    (
      await diagnostics.step(`timers.read:${purpose}`, () =>
        db.information.find({
          kinds: ["core.schedule.one-shot.requested"],
          payloadContains: { input: { purpose } },
          openOnly: true,
          limit: 1000,
        }),
      )
    ).filter((a) => (a.payload.input as any).purpose === purpose);
  const fire = async (purpose: string, ms: number) => {
    time = Date.UTC(2026, 9, 22) + ms;
    const timer = (await timers(purpose))[0]!;
    expect(timer).toBeDefined();
    await diagnostics.step(`due.register:${purpose}`, () =>
      core.register(oneShotDueInformationKind, {
        occurredAt: now().toISOString(),
        source: "core:test",
        payload: {
          deliveredAt: now().toISOString(),
          scheduleInformationId: timer.informationId,
          dueAt: String(timer.payload.dueAt),
        },
        references: [
          { relation: "core:status-of", informationId: timer.informationId },
        ],
      }),
    );
    await settle(`due.settle:${purpose}`);
  };
  const context = await diagnostics.step("runtime-context.register", () =>
    core.register(runtimeContext, {
      occurredAt: now().toISOString(),
      source: "core:test",
      payload: {},
      references: [],
    }),
  );
  const inbound = async (
    direct: boolean,
    senderId = "user",
    wait = true,
    address: SceneAddress = {
      platform: "qq",
      adapterId: "qq.main",
      destination: { kind: "group", groupId: "g" },
    },
  ) => {
    const atom = await diagnostics.step(
      `inbound.register:${direct ? "direct" : "ordinary"}:${senderId}`,
      () =>
        core.register(inboundTextInformationKind, {
          occurredAt: now().toISOString(),
          source: "adapter:test",
          payload: {
            text: "hello",
            source: {
              ...address,
              senderId,
              selfId: "bot",
              platformMessageId: `m${n}`,
              ...(direct ? { mentions: [{ kind: "user", id: "bot" }] } : {}),
            },
          },
          references: [
            { relation: "core:context", informationId: context.informationId },
          ],
        }),
    );
    if (wait)
      await settle(
        `inbound.settle:${direct ? "direct" : "ordinary"}:${senderId}`,
      );
    return atom;
  };
  if (beforeStart)
    await diagnostics.step("seed", () =>
      beforeStart({ db, core, scheduler, inbound, now }),
    );
  await diagnostics.step("host.start", () =>
    host.start([
      {
        instanceId: "lifecycle.default",
        definitionId: "agent.lifecycle",
        settings: lifecycleSettingsSchema.parse({}),
      },
    ]),
  );
  await settle("startup.settle");
  return {
    db,
    restart: async () => {
      await diagnostics.step("restart.close", () =>
        closeTestResources([() => core.close(), () => host.stop()]),
      );
      core = makeCore();
      scheduler = new OneShotScheduleClient(core);
      await diagnostics.step("restart.core.start", () => core.start());
      host = makeHost();
      await diagnostics.step("restart.host.start", () =>
        host.start([
          {
            instanceId: "lifecycle.default",
            definitionId: "agent.lifecycle",
            settings: lifecycleSettingsSchema.parse({}),
          },
        ]),
      );
      await settle("restart.settle");
    },
    get scheduler() {
      return scheduler;
    },
    get core() {
      return core;
    },
    get host() {
      return host;
    },
    now,
    state,
    timers,
    fire,
    inbound,
    all,
    settle,
    start,
    advance: (ms: number) => {
      time = Date.UTC(2026, 9, 22) + ms;
    },
  };
}
lifecycleTest(
  "starts without inbound, coalesces missed ticks, sleeps and keeps empty rechecks model-free",
  { due: 3 },
  async (diagnostics) => {
    const f = await fixture(diagnostics);
    expect(await f.state()).toMatchObject({ state: "awake" });
    expect(await f.timers("lifecycle-pulse")).toHaveLength(1);
    await f.fire("lifecycle-pulse", 599999);
    expect(await f.state()).toMatchObject({ state: "awake" });
    await f.fire("lifecycle-pulse", 600000);
    expect(await f.state()).toMatchObject({ state: "asleep" });
    expect(await f.timers("lifecycle-pulse")).toHaveLength(0);
    const recheck = (await f.timers("periodic-wake"))[0]!;
    expect(recheck.payload.dueAt).toBe(
      new Date(Date.UTC(2026, 9, 22) + 900000).toISOString(),
    );
    await f.fire("periodic-wake", 900000);
    expect(await f.state()).toMatchObject({ state: "asleep" });
    expect(await f.all("core.model.task.requested")).toHaveLength(0);
    expect(await f.timers("periodic-wake")).toHaveLength(1);
  },
);
lifecycleTest(
  "buffers ordinary messages without moving recheck, but direct messages wake immediately",
  { due: 1, inbound: 2 },
  async (diagnostics) => {
    const f = await fixture(diagnostics);
    await f.fire("lifecycle-pulse", 600000);
    const deadline = (await f.timers("periodic-wake"))[0]!.payload.dueAt;
    f.advance(610000);
    await f.inbound(false);
    expect(await f.state()).toMatchObject({ state: "asleep" });
    expect((await f.timers("periodic-wake"))[0]!.payload.dueAt).toBe(deadline);
    await f.inbound(true);
    expect(await f.state()).toMatchObject({ state: "awake" });
    expect(await f.timers("lifecycle-pulse")).toHaveLength(1);
  },
);
lifecycleTest(
  "repeated startup preserves the single open pulse and current span",
  { startup: 1 },
  async (diagnostics) => {
    const f = await fixture(diagnostics);
    f.advance(300000);
    await f.start("lifecycle.default");
    await f.settle("repeated-startup.settle");
    expect(await f.timers("lifecycle-pulse")).toHaveLength(1);
    expect((await f.state()).timeline).toHaveLength(1);
  },
);

lifecycleTest(
  "an unfinished model step blocks idle sleep and its completion resets actual activity",
  { register: 2, due: 2 },
  async (diagnostics) => {
    const f = await fixture(diagnostics);
    const task = await diagnostics.step("model.request.register", () =>
      f.core.register(taskRequested, {
        occurredAt: f.now().toISOString(),
        source: "core:test",
        payload: {},
        references: [],
      }),
    );
    await f.fire("lifecycle-pulse", 600000);
    expect(await f.state()).toMatchObject({ state: "awake" });
    expect((await f.state()).timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ activity: "working" }),
      ]),
    );
    f.advance(610000);
    await diagnostics.step("model.complete.register", () =>
      f.core.register(taskCompleted, {
        occurredAt: f.now().toISOString(),
        source: "core:test",
        payload: {},
        references: [
          { relation: "core:status-of", informationId: task.informationId },
        ],
      }),
    );
    await f.fire("lifecycle-pulse", 620000);
    expect(await f.state()).toMatchObject({
      state: "awake",
      lastActivityAt: new Date(Date.UTC(2026, 9, 22) + 610000).toISOString(),
    });
  },
);

lifecycleTest(
  "a periodic observation wake stays awake instead of immediately restoring sleep",
  { due: 1, register: 1, settle: 1 },
  async (diagnostics) => {
    const f = await fixture(diagnostics);
    await f.fire("lifecycle-pulse", 600000);
    f.advance(900000);
    await diagnostics.step("arousal.register", () =>
      f.core.register(attentionArousalStateRecordedInformationKind, {
        occurredAt: f.now().toISOString(),
        source: "module:test",
        payload: {
          state: "awake",
          cause: "signal",
          scopeKey: "qq:qq.main:group:g",
          candidateInformationId: "pending-observation",
          lastEvaluatedAt: f.now().toISOString(),
          lastActivityAt: new Date(Date.UTC(2026, 9, 22)).toISOString(),
          lastInboundInformationId: null,
          sleepStartedAt: null,
          lastPeriodicWakeAt: f.now().toISOString(),
          reasonCodes: ["periodic-recheck"],
          policyVersion: "attention-observation.v1",
        },
        references: [],
      }),
    );
    await f.settle("arousal.settle");
    expect(await f.state()).toMatchObject({
      state: "awake",
      lastActivityAt: f.now().toISOString(),
    });
    expect(await f.timers("lifecycle-pulse")).toHaveLength(1);
  },
);
lifecycleTest(
  "consumes a persisted legacy-instance recheck and schedules its successor under Lifecycle",
  { due: 2, replace: 1 },
  async (diagnostics) => {
    const f = await fixture(diagnostics);
    await f.fire("lifecycle-pulse", 600000);
    const timer = (await f.timers("periodic-wake"))[0]!;
    const source = (await f.all("agent.lifecycle.state.recorded"))[0]!;
    const legacy = await diagnostics.step("legacy.replace", () =>
      f.scheduler.replace({
        previousScheduleInformationId: timer.informationId,
        operationKey: "legacy-recheck",
        sourceInformationId: source.informationId,
        dueAt: String(timer.payload.dueAt),
        input: { purpose: "periodic-wake" },
        activation: {
          definitionId: "agent.attention.arousal",
          instanceId: "attention-arousal.default",
        },
      }),
    );
    await f.fire("periodic-wake", 900000);
    const next = await f.timers("periodic-wake");
    expect(next).toHaveLength(1);
    expect(next[0]!.informationId).not.toBe(legacy.scheduleInformationId);
    expect(next[0]!.payload.activation).toMatchObject({
      definitionId: "agent.lifecycle",
      instanceId: "lifecycle.default",
    });
  },
);

lifecycleTest(
  "recovers every sender and message in the same scene after downtime without another input",
  { stop: 1, register: 3, restart: 2 },
  async (diagnostics) => {
    const f = await fixture(diagnostics);
    await diagnostics.step("offline.host.stop", () => f.host.stop());
    const first = await f.inbound(false, "alice", false);
    const second = await f.inbound(false, "bob", false);
    const third = await f.inbound(true, "carol", false);
    expect(
      new Set(
        [first, second, third].map((a) => a.payload.source.platformMessageId),
      ).size,
    ).toBe(3);
    await f.restart();
    const candidates = await f.all("agent.heartbeat.candidate");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.payload.unreadCount).toBe(3);
    expect(candidates[0]!.payload.unreadThroughInformationId).toBe(
      third.informationId,
    );
    expect(candidates[0]!.payload.unreadAfterInformationId).toBeUndefined();
    const wakes = await f.all("agent.heartbeat.observation.wake");
    expect(
      wakes[0]!.references
        .filter((r) => r.relation === "core:uses-context")
        .map((r) => r.informationId),
    ).toEqual([first.informationId, second.informationId, third.informationId]);
    await f.restart();
    expect(await f.all("agent.heartbeat.candidate")).toHaveLength(1);
  },
);

async function seedOpenOwners(db: KaguyaDatabase, templateId: string) {
  const template = (await db.information.get(templateId))!;
  expect(template.kind).toBe(oneShotRequestedInformationKind.kind);
  // 独立 ID 空间，不消耗或碰撞 fixture 的 lifecycle-N 序列。
  const atoms = Array.from({ length: 1000 }, (_, i) =>
    informationAtomSchema.parse({
      ...template,
      informationId: `pagination-owner-${String(i).padStart(4, "0")}`,
      payload: oneShotRequestedInformationKind.payloadSchema.parse({
        ...template.payload,
        operationKey: `other-scene:${i}`,
        input: { purpose: "other", scopeKey: `qq:qq.main:group:other-${i}` },
      }),
    }),
  );
  const ids = atoms.map((a) => a.informationId);
  const serialized = JSON.stringify(atoms);
  await db.sql.transaction(async (tx) => {
    // Host 尚未安装订阅；真实 schedule 在此阶段也不产生 durable delivery 或 log outbox。
    expect(
      (await tx.query("SELECT 1 FROM information_subscriptions")).rows,
    ).toHaveLength(0);
    await tx.query(
      `INSERT INTO information_atoms(information_id,kind,occurred_at,source,payload)
       SELECT a->>'informationId',a->>'kind',a->>'occurredAt',a->>'source',a->'payload'
       FROM jsonb_array_elements($1::jsonb) a ORDER BY a->>'informationId'`,
      [serialized],
    );
    await tx.query(
      `INSERT INTO information_lifecycle(information_id,kind,scope_key,occurred_at,is_open)
       SELECT information_id,kind,payload->'input'->>'scopeKey',occurred_at::timestamptz,true
       FROM information_atoms WHERE information_id=ANY($1::text[]) ORDER BY information_id`,
      [ids],
    );
    await tx.query(
      `INSERT INTO information_references(information_id,ordinal,relation,target_information_id)
       SELECT a->>'informationId',r.ordinality-1,r.value->>'relation',r.value->>'informationId'
       FROM jsonb_array_elements($1::jsonb) a,
       LATERAL jsonb_array_elements(a->'references') WITH ORDINALITY r(value,ordinality)`,
      [serialized],
    );
    await tx.query(
      `INSERT INTO information_commit_slots(slot_type,namespace,key,information_id)
       SELECT 'operation','kaguya.schedule.one-shot.schedule.v1',payload->>'operationKey',information_id
       FROM information_atoms WHERE information_id=ANY($1::text[])`,
      [ids],
    );
    await tx.query(
      `INSERT INTO information_schedule_arms(schedule_information_id,due_at,state)
       SELECT information_id,(payload->>'dueAt')::timestamptz,'open'
       FROM information_atoms WHERE information_id=ANY($1::text[])`,
      [ids],
    );
    const integrity = await tx.query<{ owners: number; positions: number }>(
      `SELECT count(*)::int owners,count(DISTINCT l.position)::int positions
       FROM information_atoms a JOIN information_lifecycle l USING(information_id)
       JOIN information_references r ON r.information_id=a.information_id AND r.ordinal=0
         AND r.relation='core:caused-by' AND r.target_information_id=$2
       JOIN information_commit_slots c ON c.information_id=a.information_id AND c.slot_type='operation'
         AND c.namespace='kaguya.schedule.one-shot.schedule.v1' AND c.key=a.payload->>'operationKey'
       JOIN information_schedule_arms arm ON arm.schedule_information_id=a.information_id
         AND arm.state='open' AND arm.due_at=(a.payload->>'dueAt')::timestamptz
       WHERE a.information_id=ANY($1::text[]) AND l.is_open AND l.kind=a.kind
         AND l.scope_key=a.payload->'input'->>'scopeKey' AND l.occurred_at=a.occurred_at::timestamptz`,
      [ids, template.references[0]!.informationId],
    );
    expect(integrity.rows).toEqual([{ owners: 1000, positions: 1000 }]);
  });
  return ids;
}

const postgresUrl = process.env.KAGUYA_TEST_DATABASE_URL;
const paginationDatabases = [
  { name: "PGlite", create: () => createTestingDatabase() },
  ...(postgresUrl
    ? [
        {
          name: "PostgreSQL",
          create: () => createPostgresTestingDatabase(postgresUrl),
        },
      ]
    : []),
];
it.for(paginationDatabases)(
  "preserves a deferred scene behind more than one page of open owners until its deadline ($name)",
  { timeout: bodyTimeout(paginationBudget) },
  ({ name, create }, context) =>
    withDiagnostics(context, paginationBudget, name, async (diagnostics) => {
      let targetTimer!: string;
      let tailTimer!: string;
      const f = await fixture(
        diagnostics,
        async ({ db, core, scheduler, inbound, now }) => {
          const source = await inbound(false, "alice", false);
          const dueAt = new Date(now().getTime() + 300000).toISOString();
          targetTimer = (
            await scheduler.schedule({
              operationKey: "target-defer",
              sourceInformationId: source.informationId,
              dueAt,
              input: {
                purpose: "observation-recheck",
                scopeKey: "qq:qq.main:group:g",
              },
              activation: {
                definitionId: "agent.lifecycle",
                instanceId: "lifecycle.default",
              },
            })
          ).scheduleInformationId;
          // 原选择器默认倒序只取 1000 条；较早的 targetTimer 将被这些独立场景挤出。
          const fillers = await seedOpenOwners(db, targetTimer);
          // 另一个有输入的场景放在尾页，同时验证正序和倒序都不能只读取首 1000 条。
          const first = (await core.store.get(source.informationId))!;
          const tail = await core.register(inboundTextInformationKind, {
            occurredAt: now().toISOString(),
            source: "adapter:test",
            payload: {
              text: "tail scene input",
              source: {
                platform: "qq",
                adapterId: "qq.main",
                destination: { kind: "group", groupId: "tail" },
                senderId: "bob",
                selfId: "bot",
                platformMessageId: "tail-input",
              },
            },
            references: [...first.references],
          });
          tailTimer = (
            await scheduler.schedule({
              operationKey: "tail-defer",
              sourceInformationId: tail.informationId,
              dueAt,
              input: {
                purpose: "observation-recheck",
                scopeKey: "qq:qq.main:group:tail",
              },
              activation: {
                definitionId: "agent.lifecycle",
                instanceId: "lifecycle.default",
              },
            })
          ).scheduleInformationId;
          // 启动前只有这 1002 个 owner；启动后 Lifecycle 还会新增自己的 pulse。
          const query = {
            kinds: [oneShotRequestedInformationKind.kind],
            openOnly: true,
            registrationOrder: true,
            order: "asc" as const,
            limit: 1000,
          };
          const firstPage = await core.find(query);
          expect(firstPage).toHaveLength(1000);
          const secondPage = await core.find({
            ...query,
            afterInformationId: firstPage.at(-1)!.informationId,
          });
          expect(secondPage).toHaveLength(2);
          expect(
            await core.find({
              ...query,
              afterInformationId: secondPage.at(-1)!.informationId,
            }),
          ).toHaveLength(0);
          const owners = [...firstPage, ...secondPage];
          expect(owners).toHaveLength(1002);
          expect(owners.map((a) => a.informationId)).toEqual([
            targetTimer,
            ...fillers,
            tailTimer,
          ]);
        },
        create,
      );
      expect(await f.all("agent.heartbeat.candidate")).toHaveLength(0);
      await f.restart();
      expect(await f.all("agent.heartbeat.candidate")).toHaveLength(0);
      for (const timerId of [targetTimer, tailTimer])
        expect((await f.db.information.get(timerId))?.payload.dueAt).toBe(
          new Date(Date.UTC(2026, 9, 22) + 300000).toISOString(),
        );
      // 到期交付只恢复原输入；整个场景没有后续入站。
      await f.fire("observation-recheck", 300000);
      expect(await f.all("agent.heartbeat.candidate")).toHaveLength(1);
      await f.fire("observation-recheck", 300000);
      const candidates = await f.all("agent.heartbeat.candidate");
      expect(candidates).toHaveLength(2);
      expect(new Set(candidates.map((c) => c.payload.scopeKey))).toEqual(
        new Set(["qq:qq.main:group:g", "qq:qq.main:group:tail"]),
      );
      expect(await f.all(inboundTextInformationKind.kind)).toHaveLength(2);
    }),
);

for (const backend of paginationDatabases) {
  const budget = ordinaryBudget({ register: 4, restart: 1, due: 1 });
  it(
    `keeps colliding legacy scenes independent through deferred restart and due recovery (${backend.name})`,
    { timeout: bodyTimeout(budget) },
    (testContext) =>
      withDiagnostics(
        testContext,
        budget,
        backend.name,
        async (diagnostics) => {
          const first: SceneAddress = {
            platform: "a:b",
            adapterId: "c",
            destination: { kind: "group", groupId: "d" },
          };
          const second: SceneAddress = {
            platform: "a",
            adapterId: "b:c",
            destination: { kind: "group", groupId: "d" },
          };
          let firstInput = "",
            secondInput = "",
            timerId = "";
          const f = await fixture(
            diagnostics,
            async ({ inbound, scheduler, now }) => {
              firstInput = (await inbound(false, "alice", false, first))
                .informationId;
              secondInput = (await inbound(false, "bob", false, second))
                .informationId;
              timerId = (
                await scheduler.schedule({
                  operationKey: "collision-legacy-defer",
                  sourceInformationId: firstInput,
                  dueAt: new Date(now().getTime() + 300000).toISOString(),
                  input: {
                    purpose: "observation-recheck",
                    scopeKey: "a:b:c:group:d",
                  },
                  activation: {
                    definitionId: "agent.lifecycle",
                    instanceId: "lifecycle.default",
                  },
                })
              ).scheduleInformationId;
            },
            backend.create,
          );
          const candidates = await f.all("agent.heartbeat.candidate");
          expect(candidates).toHaveLength(1);
          expect(
            sceneIdentity(candidates[0]!.payload as unknown as SceneAddress),
          ).toBe(sceneIdentity(second));
          expect(candidates[0]!.payload.unreadThroughInformationId).toBe(
            secondInput,
          );
          expect(candidates[0]!.payload.unreadCount).toBe(1);
          expect(
            (await f.timers("observation-recheck")).map((a) => a.informationId),
          ).toEqual([timerId]);
          await f.restart();
          expect(await f.all("agent.heartbeat.candidate")).toHaveLength(1);
          expect(
            (await f.timers("observation-recheck"))[0]!.payload.dueAt,
          ).toBe(new Date(Date.UTC(2026, 9, 22) + 300000).toISOString());
          await f.fire("observation-recheck", 300000);
          const recovered = await f.all("agent.heartbeat.candidate");
          expect(recovered).toHaveLength(2);
          expect(
            new Set(
              recovered.map((a) =>
                sceneIdentity(a.payload as unknown as SceneAddress),
              ),
            ),
          ).toEqual(new Set([sceneIdentity(first), sceneIdentity(second)]));
          expect(
            new Set(recovered.map((a) => a.payload.unreadThroughInformationId)),
          ).toEqual(new Set([firstInput, secondInput]));
          expect(recovered.every((a) => a.payload.unreadCount === 1)).toBe(
            true,
          );
          expect(await f.timers("observation-recheck")).toHaveLength(0);
          expect(await f.all("core.model.task.requested")).toHaveLength(0);
        },
      ),
  );
}
