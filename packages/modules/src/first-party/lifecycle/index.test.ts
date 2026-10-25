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
  for (const close of clean.splice(0).reverse()) await close();
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
async function fixture() {
  const db = await createTestingDatabase();
  await db.prepareSchema();
  const catalog = defineInformationModuleCatalog(
    createLifecycleModule({ timeZone: "Asia/Shanghai" }),
  );
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
  const core = new InformationCore({
    registry,
    store: db.information,
    now,
    nextInformationId: () => `lifecycle-${String(++n).padStart(6, "0")}`,
  });
  const scheduler = new OneShotScheduleClient(core);
  const start = async (instanceId: string) => {
    await core.register(lifecycleStartedInformationKind, {
      occurredAt: now().toISOString(),
      source: "module:test",
      payload: { instanceId, at: now().toISOString() },
      references: [],
    });
  };
  const host = new ModuleHost({
    core,
    catalog,
    now,
    capabilities: [
      { capability: oneShotScheduleCapability, value: scheduler },
      { capability: lifecycleStartupCapability, value: { start } },
    ],
  });
  await core.start();
  clean.push(async () => {
    await host.stop();
    await core.close();
    await db.close();
  });
  await host.start([
    {
      instanceId: "lifecycle.default",
      definitionId: "agent.lifecycle",
      settings: lifecycleSettingsSchema.parse({}),
    },
  ]);
  const settle = () =>
    vi.waitFor(
      async () => {
        const health = await db.information.reliable.health();
        expect(health.pending).toBe(0);
        expect(health.exhausted).toBe(0);
      },
      { timeout: 5000 },
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
  const inbound = async (direct: boolean) => {
    await core.register(inboundTextInformationKind, {
      occurredAt: now().toISOString(),
      source: "adapter:test",
      payload: {
        text: "hello",
        source: {
          platform: "qq",
          adapterId: "qq.main",
          destination: { kind: "group", groupId: "g" },
          senderId: "user",
          selfId: "bot",
          platformMessageId: `m${n}`,
          ...(direct ? { mentions: [{ kind: "user", id: "bot" }] } : {}),
        },
      },
      references: [
        { relation: "core:context", informationId: context.informationId },
      ],
    });
    await settle();
  };
  await settle();
  return {
    db,
    scheduler,
    core,
    host,
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
