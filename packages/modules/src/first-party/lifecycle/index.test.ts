/**
 * 功能概述：通过真实 Core、ModuleHost、Scheduler 与 PGlite 验证 Lifecycle 状态、调度和观察恢复。
 * 主要职责：fixture 提供合成时钟、入站与手动 due；settle 等待持久队列并报告处理错误。
 * restart 关闭原 core/runner 后重建宿主和绑定能力，保留数据库、订阅 ID、时钟与 ID 序列。
 * 代码库关系：直接运行 createLifecycleModule，覆盖离线期间多人消息及无新入站的启动恢复。
 * 超页回归登记 1002 个开放调度，验证重启保持原 deadline；30 秒仅覆盖该例批量设置，收敛仍用 8 秒预算。
 * 资源取得后立即登记清理；启动拒绝或 stop 失败时仍顺序释放全部资源并汇总错误。
 * 输入输出与副作用：每例独立数据库，8 秒/20 毫秒条件等待；结束关闭 host/core/数据库，不请求外部服务。
 */
import { closeTestResources } from "../test-support/cleanup.js";
import { observationCapability } from "@kaguya/sdk";
import { afterEach, expect, it, vi } from "vitest";
import { createTestingDatabase } from "@kaguya/database/testing";
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
import { z } from "@kaguya/schema";
import {
  OneShotScheduleClient,
  oneShotDueInformationKind,
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
  beforeStart?: (seed: {
    core: InformationCore;
    scheduler: OneShotScheduleClient;
    inbound: (
      direct: boolean,
      senderId?: string,
      wait?: boolean,
    ) => Promise<{ informationId: string }>;
    now: () => Date;
  }) => Promise<void>,
) {
  const db = await createTestingDatabase();
  clean.push(() => db.close());
  await db.prepareSchema();
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
    await core.register(lifecycleStartedInformationKind, {
      occurredAt: now().toISOString(),
      source: "module:test",
      payload: { instanceId, at: now().toISOString() },
      references: [],
    });
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
  await core.start();

  const settle = () =>
    vi.waitFor(
      async () => {
        const health = await db.information.reliable.health();
        if (failures.length) throw failures[0];
        expect(health.pending).toBe(0);
        expect(health.exhausted).toBe(0);
      },
      { timeout: 8000, interval: 20 },
    );
  const all = (kind: string) =>
    db.information.find({
      kinds: [kind],
      registrationOrder: true,
      order: "desc",
      limit: 1000,
    });
  const state = async () =>
    (await all("agent.lifecycle.state.recorded"))[0]!.payload;
  const timers = async (purpose: string) =>
    (
      await db.information.find({
        kinds: ["core.schedule.one-shot.requested"],
        payloadContains: { input: { purpose } },
        openOnly: true,
        limit: 1000,
      })
    ).filter((a) => (a.payload.input as any).purpose === purpose);
  const fire = async (purpose: string, ms: number) => {
    time = Date.UTC(2026, 9, 22) + ms;
    const timer = (await timers(purpose))[0]!;
    expect(timer).toBeDefined();
    await core.register(oneShotDueInformationKind, {
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
    });
    await settle();
  };
  const context = await core.register(runtimeContext, {
    occurredAt: now().toISOString(),
    source: "core:test",
    payload: {},
    references: [],
  });
  const inbound = async (direct: boolean, senderId = "user", wait = true) => {
    const atom = await core.register(inboundTextInformationKind, {
      occurredAt: now().toISOString(),
      source: "adapter:test",
      payload: {
        text: "hello",
        source: {
          platform: "qq",
          adapterId: "qq.main",
          destination: { kind: "group", groupId: "g" },
          senderId,
          selfId: "bot",
          platformMessageId: `m${n}`,
          ...(direct ? { mentions: [{ kind: "user", id: "bot" }] } : {}),
        },
      },
      references: [
        { relation: "core:context", informationId: context.informationId },
      ],
    });
    if (wait) await settle();
    return atom;
  };
  await beforeStart?.({ core, scheduler, inbound, now });
  await host.start([
    {
      instanceId: "lifecycle.default",
      definitionId: "agent.lifecycle",
      settings: lifecycleSettingsSchema.parse({}),
    },
  ]);
  await settle();
  return {
    db,
    restart: async () => {
      await closeTestResources([() => core.close(), () => host.stop()]);
      core = makeCore();
      scheduler = new OneShotScheduleClient(core);
      await core.start();
      host = makeHost();
      await host.start([
        {
          instanceId: "lifecycle.default",
          definitionId: "agent.lifecycle",
          settings: lifecycleSettingsSchema.parse({}),
        },
      ]);
      await settle();
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
it("starts without inbound, coalesces missed ticks, sleeps and keeps empty rechecks model-free", async () => {
  const f = await fixture();
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
});
it("buffers ordinary messages without moving recheck, but direct messages wake immediately", async () => {
  const f = await fixture();
  await f.fire("lifecycle-pulse", 600000);
  const deadline = (await f.timers("periodic-wake"))[0]!.payload.dueAt;
  f.advance(610000);
  await f.inbound(false);
  expect(await f.state()).toMatchObject({ state: "asleep" });
  expect((await f.timers("periodic-wake"))[0]!.payload.dueAt).toBe(deadline);
  await f.inbound(true);
  expect(await f.state()).toMatchObject({ state: "awake" });
  expect(await f.timers("lifecycle-pulse")).toHaveLength(1);
});
it("repeated startup preserves the single open pulse and current span", async () => {
  const f = await fixture();
  f.advance(300000);
  await f.start("lifecycle.default");
  await f.settle();
  expect(await f.timers("lifecycle-pulse")).toHaveLength(1);
  expect((await f.state()).timeline).toHaveLength(1);
});

it("an unfinished model step blocks idle sleep and its completion resets actual activity", async () => {
  const f = await fixture();
  const task = await f.core.register(taskRequested, {
    occurredAt: f.now().toISOString(),
    source: "core:test",
    payload: {},
    references: [],
  });
  await f.fire("lifecycle-pulse", 600000);
  expect(await f.state()).toMatchObject({ state: "awake" });
  expect((await f.state()).timeline).toEqual(
    expect.arrayContaining([expect.objectContaining({ activity: "working" })]),
  );
  f.advance(610000);
  await f.core.register(taskCompleted, {
    occurredAt: f.now().toISOString(),
    source: "core:test",
    payload: {},
    references: [
      { relation: "core:status-of", informationId: task.informationId },
    ],
  });
  await f.fire("lifecycle-pulse", 620000);
  expect(await f.state()).toMatchObject({
    state: "awake",
    lastActivityAt: new Date(Date.UTC(2026, 9, 22) + 610000).toISOString(),
  });
});

it("a periodic observation wake stays awake instead of immediately restoring sleep", async () => {
  const f = await fixture();
  await f.fire("lifecycle-pulse", 600000);
  f.advance(900000);
  await f.core.register(attentionArousalStateRecordedInformationKind, {
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
  });
  await f.settle();
  expect(await f.state()).toMatchObject({
    state: "awake",
    lastActivityAt: f.now().toISOString(),
  });
  expect(await f.timers("lifecycle-pulse")).toHaveLength(1);
});
it("consumes a persisted legacy-instance recheck and schedules its successor under Lifecycle", async () => {
  const f = await fixture();
  await f.fire("lifecycle-pulse", 600000);
  const timer = (await f.timers("periodic-wake"))[0]!;
  const source = (await f.all("agent.lifecycle.state.recorded"))[0]!;
  const legacy = await f.scheduler.replace({
    previousScheduleInformationId: timer.informationId,
    operationKey: "legacy-recheck",
    sourceInformationId: source.informationId,
    dueAt: String(timer.payload.dueAt),
    input: { purpose: "periodic-wake" },
    activation: {
      definitionId: "agent.attention.arousal",
      instanceId: "attention-arousal.default",
    },
  });
  await f.fire("periodic-wake", 900000);
  const next = await f.timers("periodic-wake");
  expect(next).toHaveLength(1);
  expect(next[0]!.informationId).not.toBe(legacy.scheduleInformationId);
  expect(next[0]!.payload.activation).toMatchObject({
    definitionId: "agent.lifecycle",
    instanceId: "lifecycle.default",
  });
});

it("recovers every sender and message in the same scene after downtime without another input", async () => {
  const f = await fixture();
  await f.host.stop();
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
});

it("preserves a deferred scene behind more than one page of open owners until its deadline", async () => {
  let targetTimer!: string;
  let tailTimer!: string;
  const f = await fixture(async ({ core, scheduler, inbound, now }) => {
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
    for (let i = 0; i < 1000; i++)
      await scheduler.schedule({
        operationKey: `other-scene:${i}`,
        sourceInformationId: source.informationId,
        dueAt,
        input: { purpose: "other", scopeKey: `qq:qq.main:group:other-${i}` },
        activation: {
          definitionId: "agent.lifecycle",
          instanceId: "lifecycle.default",
        },
      });
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
  });
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
}, 30000);
