/**
 * 功能概述：用真实账本、ModuleHost 和 one-shot port 验证观察创建、即时唤醒和水位恢复。
 * 主要职责：fixture 注入时钟，fire 交付持久 due；断言 candidate 数与冻结来源，不调用真实模型或平台。
 * 代码库关系：直接运行 heartbeatModule 与数据库开放槽；补足单元替身无法验证的 Selector/事务边界。
 * 输入输出与副作用：每例隔离 PGlite，关闭宿主与 Core；重放 handler 和同时间戳输入验证幂等性。
 */
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
} from "@kaguya/scheduler";
import { oneShotScheduleCapability } from "@kaguya/scheduler";
import { heartbeatModule, isImmediateObservation } from "./index.js";
import { attentionArousalModule } from "../attention-arousal/index.js";
import {
  inboundTextInformationKind,
  attentionArousalStateRecordedInformationKind,
  turnSilentInformationKind,
  turnClaimedInformationKind,
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
async function fixture(
  withArousal = false,
  arousalSettings: Record<string, unknown> = {},
) {
  const db = await createTestingDatabase();
  await db.prepareSchema();
  const registry = new InformationKindRegistry();
  const catalog = withArousal
    ? defineInformationModuleCatalog(heartbeatModule, attentionArousalModule)
    : defineInformationModuleCatalog(heartbeatModule);
  const kinds = new Map(
    [
      ...catalogInformationKinds(catalog),
      runtimeContext,
      turnClaimedInformationKind,
    ].map((k) => [k.kind, k]),
  );
  for (const k of [...kinds.values()].filter(
    (k) => !k.kind.startsWith("core.schedule."),
  ))
    k.kind.startsWith("core.")
      ? registry.registerBuiltin(k)
      : registry.register(k);
  let n = 0;
  const now = () => new Date("2026-09-14T00:00:00.000Z");
  const core = new InformationCore({
    registry,
    store: db.information,
    now,
    nextInformationId: () => `observation-${String(++n).padStart(6, "0")}`,
  });
  const host = new ModuleHost({
    core,
    catalog,
    capabilities: [
      {
        capability: oneShotScheduleCapability,
        value: new OneShotScheduleClient(core),
      },
    ],
    now,
  });
  await core.start();
  await host.start([
    {
      instanceId: "heartbeat.test",
      definitionId: heartbeatModule.manifest.definitionId,
      settings: {
        maxReplacementAttempts: 3,
        totalWaitBudget: 3,
      },
    },
    ...(withArousal
      ? [
          {
            instanceId: "arousal.test",
            definitionId: attentionArousalModule.manifest.definitionId,
            settings: arousalSettings,
          },
        ]
      : []),
  ]);
  clean.push(async () => {
    await host.stop();
    await core.close();
    await db.close();
  });
  const context = await core.register(runtimeContext, {
    occurredAt: now().toISOString(),
    source: "core:test",
    payload: {},
    references: [],
  });
  const settle = () =>
    vi.waitFor(async () => {
      const h = await db.information.reliable.health();
      expect(h.pending).toBe(0);
      expect(h.exhausted).toBe(0);
    });
  const source = {
    platform: "qq",
    adapterId: "qq.main",
    destination: { kind: "group", groupId: "g" },
    senderId: "user",
    selfId: "bot",
    platformMessageId: "m",
  };
  const inbound = async (extra: any = {}) => {
    const atom = await core.register(inboundTextInformationKind, {
      occurredAt: now().toISOString(),
      source: "adapter:test",
      payload: { text: "hello", source: { ...source, ...extra } },
      references: [
        { relation: "core:context", informationId: context.informationId },
      ],
    });
    await settle();
    return atom;
  };
  const atoms = (kind: string) =>
    db.information.find({
      kinds: [kind],
      registrationOrder: true,
      order: "asc",
      limit: 1000,
    });
  const setArousalState = async (state: "awake" | "asleep") => {
    const atom = await core.register(
      attentionArousalStateRecordedInformationKind,
      {
        occurredAt: now().toISOString(),
        source: "module:test",
        payload: {
          state,
          cause: "external",
          lastEvaluatedAt: now().toISOString(),
          lastInboundInformationId: null,
          lastActivityAt: now().toISOString(),
          sleepStartedAt: state === "asleep" ? now().toISOString() : null,
          lastPeriodicWakeAt: null,
          reasonCodes: ["test"],
          policyVersion: "attention-observation.v1",
        },
        references: [
          { relation: "core:context", informationId: context.informationId },
        ],
      },
    );
    await settle();
    return atom;
  };
  const fire = async (
    definitionId = heartbeatModule.manifest.definitionId,
    purpose?: string,
  ) => {
    const arms = await db.information.oneShotSchedules.listOpen({ limit: 100 });
    for (const arm of arms.arms) {
      const request = await db.information.get(arm.scheduleInformationId);
      const payload = request?.payload as any;
      if (
        payload?.activation?.definitionId !== definitionId ||
        (purpose !== undefined && payload?.input?.purpose !== purpose)
      )
        continue;
      await core.registerOnce(
        "test.due",
        arm.scheduleInformationId,
        oneShotDueInformationKind,
        {
          occurredAt: now().toISOString(),
          source: "core:scheduler",
          payload: {
            scheduleInformationId: arm.scheduleInformationId,
            dueAt: arm.dueAt,
            deliveredAt: now().toISOString(),
          },
          references: [
            {
              relation: "core:status-of",
              informationId: arm.scheduleInformationId,
            },
          ],
        },
      );
    }
    await settle();
  };
  const finish = async (candidate: any) => {
    const claim = await core.registerOnce(
      "test.claim",
      candidate.informationId,
      turnClaimedInformationKind,
      {
        occurredAt: now().toISOString(),
        source: "module:test",
        payload: {
          candidateInformationId: candidate.informationId,
          scopeKey: candidate.payload.scopeKey,
          generation: 0,
          predecessorTerminalInformationId: null,
        },
        references: [
          {
            relation: "agent:turn-candidate",
            informationId: candidate.informationId,
          },
          { relation: "core:context", informationId: context.informationId },
          {
            relation: "core:caused-by",
            informationId: candidate.informationId,
          },
        ],
      },
    );
    const terminal = await core.commitTerminal(
      "agent.turn.terminal",
      candidate.informationId,
      turnSilentInformationKind,
      {
        occurredAt: now().toISOString(),
        source: "module:test",
        payload: {
          candidateInformationId: candidate.informationId,
          claimInformationId: claim.informationId,
          scopeKey: candidate.payload.scopeKey,
          reasonCodes: ["test"],
        },
        references: [
          {
            relation: "core:status-of",
            informationId: candidate.informationId,
          },
          { relation: "agent:turn-claim", informationId: claim.informationId },
          { relation: "core:context", informationId: context.informationId },
          { relation: "core:caused-by", informationId: claim.informationId },
        ],
      },
    );
    await settle();
    return terminal;
  };
  return {
    db,
    core,
    inbound,
    atoms,
    fire,
    finish,
    setArousalState,
  };
}
it("opens one scope immediately and carries later notifications into the next observation", async () => {
  const f = await fixture();
  await f.inbound();
  await f.inbound();
  expect(await f.atoms("consumer.failed")).toEqual([]);
  expect(await f.atoms("agent.heartbeat.scheduled")).toHaveLength(0);
  const candidates = await f.atoms("agent.turn.candidate");
  expect(candidates).toHaveLength(1);
  expect(candidates[0]!.payload).toMatchObject({
    unreadCount: 1,
    signals: ["passive"],
  });
  expect(candidates[0]!.payload).not.toHaveProperty("sourceInformationIds");
  const later = [];
  for (let i = 0; i < 10; i++) later.push(await f.inbound());
  expect(await f.atoms("agent.heartbeat.scheduled")).toHaveLength(0);
  expect(await f.atoms("agent.turn.candidate")).toHaveLength(1);
  expect(await f.atoms("agent.observation.wake")).toHaveLength(11);
  await f.finish(candidates[0]);
  const all = await f.atoms("agent.turn.candidate");
  expect(all).toHaveLength(2);
  expect(all[1]!.payload).toMatchObject({
    unreadThroughInformationId: later.at(-1)!.informationId,
    unreadCount: 12,
  });
  await f.finish(all[1]);
  expect(await f.atoms("agent.heartbeat.scheduled")).toHaveLength(0);
  expect(await f.atoms("consumer.failed")).toHaveLength(0);
});
it("marks a direct notification as an immediate wake for the open scope", async () => {
  const f = await fixture();
  await f.inbound();
  await f.inbound({ mentions: [{ kind: "user", id: "bot" }] });
  expect(await f.atoms("agent.heartbeat.scheduled")).toHaveLength(0);
  expect(await f.atoms("agent.turn.candidate")).toHaveLength(1);
  const wakes = await f.atoms("agent.observation.wake");
  expect(wakes).toHaveLength(1);
  expect(wakes.at(-1)!.payload.immediate).toBe(true);
});
it("defaults Arousal to awake and observes the first passive opportunity", async () => {
  const f = await fixture(true);
  await f.inbound();
  await vi.waitFor(async () => {
    const decisions = await f.atoms("agent.attention.arousal.completed");
    expect(decisions.map((atom) => atom.payload.outcome)).toEqual(["observe"]);
    expect(decisions[0]!.payload).toMatchObject({
      arousalState: "awake",
      wakeSignal: false,
      reasonCodes: ["arousal-awake"],
    });
  });
  expect(await f.atoms("agent.heartbeat.scheduled")).toHaveLength(0);
  expect(await f.atoms("agent.attention.arousal.state.recorded")).toHaveLength(
    1,
  );
});

it("defers during night sleep and lets the periodic deadline recheck accumulated unread", async () => {
  const f = await fixture(true, {
    nightSleepEnabled: true,
    nightSleepStart: "00:00",
    nightSleepEnd: "23:59",
  });
  await f.setArousalState("asleep");
  await f.inbound();
  await vi.waitFor(async () => {
    const decisions = await f.atoms("agent.attention.arousal.completed");
    expect(decisions.map((atom) => atom.payload.outcome)).toEqual(["defer"]);
    expect(decisions[0]!.payload).toMatchObject({
      arousalState: "asleep",
      wakeSignal: false,
      reasonCodes: ["arousal-asleep"],
    });
  });
  const schedules = await f.atoms("agent.heartbeat.scheduled");
  expect(schedules).toHaveLength(0);
  await f.inbound();
  await vi.waitFor(async () => {
    const decisions = await f.atoms("agent.attention.arousal.completed");
    expect(decisions.map((atom) => atom.payload.outcome)).toEqual([
      "defer",
      "defer",
    ]);
    expect(decisions[1]!.payload.unreadCount).toBe(2);
  });
  await f.fire(attentionArousalModule.manifest.definitionId, "periodic-wake");
  await vi.waitFor(async () => {
    const decisions = await f.atoms("agent.attention.arousal.completed");
    expect(decisions.map((atom) => atom.payload.outcome)).toEqual([
      "defer",
      "defer",
      "observe",
    ]);
    expect(decisions[2]!.payload.signals).toContain("recheck");
    expect(decisions[2]!.payload.unreadCount).toBe(2);
    expect(decisions[2]!.payload).toMatchObject({
      arousalState: "awake",
      wakeSignal: true,
    });
  });
});
it("recognizes private, replies and broadcast mentions without treating ordinary group messages as urgent", () => {
  expect(isImmediateObservation({ destination: { kind: "private" } })).toBe(
    true,
  );
  expect(
    isImmediateObservation({ selfId: "bot", replyTo: { senderId: "bot" } }),
  ).toBe(true);
  expect(isImmediateObservation({ mentions: [{ kind: "all" }] })).toBe(true);
  expect(
    isImmediateObservation({
      destination: { kind: "group" },
      selfId: "bot",
      mentions: [{ kind: "user", id: "other" }],
    }),
  ).toBe(false);
});
