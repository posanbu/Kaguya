/**
 * 功能概述：验证 Heartbeat 即时提升已有 schedule 时仍携带已聚合输入。
 * 主要职责：注入 one-shot 替身，断言替换 deadline、来源顺序与旧 heartbeat 终态。
 * 代码库关系：真实数据库和开放槽行为由 observation.test.ts 覆盖；本文件隔离 capability 协议。
 * 输入输出与副作用：只使用固定时钟和模拟回执，不访问模型或平台。
 */
import { freezeInformationAtom, informationIdSchema } from "@kaguya/schema";
import {
  oneShotRequestedInformationKind,
  oneShotScheduleCapability,
  type OneShotScheduleCapability,
} from "@kaguya/scheduler";
import { describe, expect, it, vi } from "vitest";

import { heartbeatModule, heartbeatSettingsSchema } from "./index.js";
import {
  heartbeatDeferredObservationSelector,
  heartbeatObservationSelector,
  heartbeatScopeSelector,
} from "./observation.js";
import {
  attentionArousalActivityInformationKind,
  attentionArousalCompletedInformationKind,
  heartbeatScheduledInformationKind,
  heartbeatSupersededInformationKind,
  attentionArousalStateRecordedInformationKind,
  inboundTextInformationKind,
  turnCandidateInformationKind,
  turnContextCompletedInformationKind,
} from "../information-kinds.js";

const source = {
  adapterId: "adapter",
  platform: "web",
  platformMessageId: "message-2",
  destination: { kind: "web" as const },
  senderId: "web",
};

describe("heartbeatModule", () => {
  it("has no cadence dependency and produces activity facts", () => {
    expect(
      heartbeatModule.manifest.consumes.some(({ kind }) =>
        kind.includes("cadence"),
      ),
    ).toBe(false);
    expect(heartbeatModule.manifest.produces.map(({ kind }) => kind)).toContain(
      attentionArousalActivityInformationKind.kind,
    );
  });

  it("opens the accumulated scope immediately when a notification arrives", async () => {
    const schedule = vi.fn<OneShotScheduleCapability["schedule"]>();
    const oneShot: OneShotScheduleCapability = {
      schedule,
      replace: async () => {
        throw new Error("unexpected replace");
      },
      finish: async () => {
        throw new Error("unexpected finish");
      },
    };
    const instance = await heartbeatModule.create(
      {
        instanceId: "heartbeat.test",
        settings: heartbeatSettingsSchema.parse({
          maxReplacementAttempts: 3,
          totalWaitBudget: 3,
        }),
        activation: {
          instanceId: "heartbeat.test",
          definitionId: heartbeatModule.manifest.definitionId,
        },
      },
      {
        signal: new AbortController().signal,
        now: () => new Date("2026-09-08T00:00:10.000Z"),
        report: async () => undefined,
        use: () => oneShot as never,
      },
    );
    const inbound = freezeInformationAtom({
      informationId: informationIdSchema.parse("inbound-direct"),
      kind: inboundTextInformationKind.kind,
      occurredAt: "2026-09-08T00:00:09.000Z",
      source: "adapter:test",
      payload: {
        text: "pending",
        source: {
          ...source,
          platform: "qq",
          adapterId: "adapter",
          destination: { kind: "group", groupId: "room" },
        },
      },
      references: [
        {
          relation: "core:context",
          informationId: informationIdSchema.parse("runtime-context-direct"),
        },
      ],
    });
    const registerOnce = vi.fn(async () => inbound);
    const select = vi
      .fn()
      .mockResolvedValueOnce([inbound])
      .mockResolvedValueOnce([]);

    const subscription = instance.subscriptions.find(
      ({ subscriptionId }) => subscriptionId === "heartbeat.message",
    )!;
    await subscription.handle(inbound, {
      now: () => new Date("2026-09-08T00:00:10.000Z"),
      select,
      registerOnce,
    } as never);

    expect(schedule).not.toHaveBeenCalled();
    expect(registerOnce).toHaveBeenCalledWith(
      "agent.turn.candidate",
      inbound.informationId,
      turnCandidateInformationKind,
      expect.objectContaining({
        openScope: {
          key: "qq:adapter:group:room",
          terminalGroup: "agent.turn.terminal",
        },
        payload: expect.objectContaining({
          triggerInformationId: inbound.informationId,
          reason: "message",
          unreadThroughInformationId: inbound.informationId,
          unreadCount: 1,
          signals: ["passive"],
          policyVersion: "attention-opportunity.v1",
        }),
        references: [],
      }),
    );
  });

  it("reopens all accumulated unread when a direct signal races an asleep defer", async () => {
    const oneShot: OneShotScheduleCapability = {
      schedule: async () => {
        throw new Error("unexpected schedule");
      },
      replace: async () => {
        throw new Error("unexpected replace");
      },
      finish: async () => {
        throw new Error("unexpected finish");
      },
    };
    const instance = await heartbeatModule.create(
      {
        instanceId: "heartbeat.test",
        settings: heartbeatSettingsSchema.parse({
          maxReplacementAttempts: 3,
          totalWaitBudget: 3,
        }),
        activation: {
          instanceId: "heartbeat.test",
          definitionId: heartbeatModule.manifest.definitionId,
        },
      },
      {
        signal: new AbortController().signal,
        now: () => new Date("2026-09-08T00:00:10.000Z"),
        report: async () => undefined,
        use: () => oneShot as never,
      },
    );
    const candidate = freezeInformationAtom({
      informationId: informationIdSchema.parse("candidate-deferred-direct"),
      kind: turnCandidateInformationKind.kind,
      occurredAt: "2026-09-08T00:00:08.000Z",
      source: "module:heartbeat.test",
      payload: {
        scopeKey: "qq:adapter:group:room",
        rebuildAttempt: 0,
        attempt: 0,
        totalWaitBudget: 3,
      },
      references: [],
    });
    const deferred = freezeInformationAtom({
      informationId: informationIdSchema.parse("arousal-deferred-direct"),
      kind: attentionArousalCompletedInformationKind.kind,
      occurredAt: "2026-09-08T00:00:09.000Z",
      source: "module:arousal.test",
      payload: {
        outcome: "defer",
        candidateInformationId: candidate.informationId,
      },
      references: [],
    });
    const input = (id: string, mentions: Array<Record<string, string>> = []) =>
      freezeInformationAtom({
        informationId: informationIdSchema.parse(id),
        kind: inboundTextInformationKind.kind,
        occurredAt: "2026-09-08T00:00:10.000Z",
        source: "adapter:test",
        payload: {
          text: id,
          source: {
            platform: "qq",
            adapterId: "adapter",
            destination: { kind: "group", groupId: "room" },
            senderId: "user",
            selfId: "bot",
            mentions,
          },
        },
        references: [],
      });
    const ordinary = input("inbound-ordinary");
    const direct = input("inbound-direct-race", [{ kind: "user", id: "bot" }]);
    const registerOnce = vi.fn(async () => candidate);
    const subscription = instance.subscriptions.find(
      ({ subscriptionId }) =>
        subscriptionId ===
        `heartbeat.resume.${attentionArousalCompletedInformationKind.kind}`,
    )!;

    await subscription.handle(deferred, {
      now: () => new Date("2026-09-08T00:00:10.000Z"),
      select: async (selector: { selectorId: string }) =>
        selector.selectorId === heartbeatObservationSelector.selectorId
          ? [candidate, deferred, ordinary, direct]
          : selector.selectorId === heartbeatScopeSelector.selectorId
            ? []
            : [],
      registerOnce,
    } as never);

    expect(registerOnce).toHaveBeenCalledWith(
      "agent.turn.candidate",
      deferred.informationId,
      turnCandidateInformationKind,
      expect.objectContaining({
        payload: expect.objectContaining({
          unreadThroughInformationId: direct.informationId,
          unreadCount: 2,
          signals: ["passive", "mention-self"],
        }),
      }),
    );
  });

  it("rechecks deferred unread only when the periodic timer wakes", async () => {
    const oneShot: OneShotScheduleCapability = {
      schedule: async () => {
        throw new Error("unexpected schedule");
      },
      replace: async () => {
        throw new Error("unexpected replace");
      },
      finish: async () => {
        throw new Error("unexpected finish");
      },
    };
    const instance = await heartbeatModule.create(
      {
        instanceId: "heartbeat.test",
        settings: heartbeatSettingsSchema.parse({
          maxReplacementAttempts: 3,
          totalWaitBudget: 3,
        }),
        activation: {
          instanceId: "heartbeat.test",
          definitionId: heartbeatModule.manifest.definitionId,
        },
      },
      {
        signal: new AbortController().signal,
        now: () => new Date("2026-09-08T00:00:10.000Z"),
        report: async () => undefined,
        use: () => oneShot as never,
      },
    );
    const state = freezeInformationAtom({
      informationId: informationIdSchema.parse("arousal-state-2"),
      kind: attentionArousalStateRecordedInformationKind.kind,
      occurredAt: "2026-09-08T00:00:10.000Z",
      source: "module:arousal.test",
      payload: {
        state: "asleep",
        cause: "timer",
        timerInformationId: "one-shot-due-2",
        lastEvaluatedAt: "2026-09-08T00:00:10.000Z",
        lastInboundInformationId: "inbound-2",
        lastActivityAt: "2026-09-08T00:00:09.000Z",
        sleepStartedAt: null,
        lastPeriodicWakeAt: "2026-09-08T00:00:10.000Z",
        reasonCodes: ["periodic-wake"],
        policyVersion: "attention-observation.v1",
      },
      references: [],
    });
    const candidate = freezeInformationAtom({
      informationId: informationIdSchema.parse("candidate-deferred"),
      kind: turnCandidateInformationKind.kind,
      occurredAt: "2026-09-08T00:00:00.000Z",
      source: "module:heartbeat.test",
      payload: {
        triggerInformationId: "heartbeat-old",
        reason: "message",
        dueAt: "2026-09-08T00:00:00.000Z",
        firedAt: "2026-09-08T00:00:00.000Z",
        platform: "qq",
        adapterId: "adapter",
        destination: { kind: "group", groupId: "room" },
        unreadThroughInformationId: "inbound-1",
        unreadCount: 1,
        signals: ["passive"],
        scopeKey: "qq:adapter:group:room",
        asOf: "2026-09-08T00:00:00.000Z",
        policyVersion: "attention-opportunity.v1",
        rebuildAttempt: 0,
        attempt: 0,
        totalWaitBudget: 3,
      },
      references: [
        {
          relation: "core:context",
          informationId: informationIdSchema.parse("runtime-context"),
        },
      ],
    });
    const inbound = freezeInformationAtom({
      informationId: informationIdSchema.parse("inbound-2"),
      kind: inboundTextInformationKind.kind,
      occurredAt: "2026-09-08T00:00:09.000Z",
      source: "adapter:test",
      payload: {
        text: "pending",
        source: {
          adapterId: "adapter",
          platform: "qq",
          platformMessageId: "message-2",
          destination: { kind: "group", groupId: "room" },
          senderId: "user",
        },
      },
      references: [],
    });
    const runtimeContext = freezeInformationAtom({
      informationId: informationIdSchema.parse("runtime-context"),
      kind: "core.runtime.context",
      occurredAt: "2026-09-08T00:00:00.000Z",
      source: "runtime:test",
      payload: {},
      references: [],
    });
    const registerOnce = vi.fn(async () => candidate);
    const subscription = instance.subscriptions.find(
      ({ subscriptionId }) => subscriptionId === "heartbeat.arousal-wake",
    )!;
    await subscription.handle(state, {
      select: async () => [state, runtimeContext, candidate, inbound],
      registerOnce,
    } as never);
    expect(registerOnce).toHaveBeenCalledWith(
      "agent.turn.candidate",
      `${state.informationId}:qq:adapter:group:room`,
      turnCandidateInformationKind,
      expect.objectContaining({
        payload: expect.objectContaining({
          reason: "recheck",
          triggerInformationId: state.informationId,
          unreadThroughInformationId: inbound.informationId,
          unreadCount: 1,
          signals: ["passive", "recheck"],
        }),
        references: [],
        contextInformationId: runtimeContext.informationId,
      }),
    );
  });

  it("bounds a periodic recheck at the inbound watermark captured by Arousal", async () => {
    const state = freezeInformationAtom({
      informationId: informationIdSchema.parse("arousal-state-upper"),
      kind: attentionArousalStateRecordedInformationKind.kind,
      occurredAt: "2026-09-08T00:00:10.000Z",
      source: "module:arousal.test",
      payload: {
        state: "asleep",
        cause: "timer",
        timerInformationId: "one-shot-due-upper",
        lastEvaluatedAt: "2026-09-08T00:00:10.000Z",
        lastInboundInformationId: "inbound-upper",
        lastActivityAt: "2026-09-08T00:00:09.000Z",
        sleepStartedAt: null,
        lastPeriodicWakeAt: "2026-09-08T00:00:10.000Z",
        reasonCodes: ["periodic-wake"],
        policyVersion: "attention-observation.v1",
      },
      references: [],
    });
    const outcome = freezeInformationAtom({
      informationId: informationIdSchema.parse("arousal-defer-upper"),
      kind: attentionArousalCompletedInformationKind.kind,
      occurredAt: "2026-09-08T00:00:00.000Z",
      source: "module:arousal.test",
      payload: {
        outcome: "defer",
        scopeKey: "qq:adapter:group:room",
      },
      references: [],
    });
    const candidate = freezeInformationAtom({
      informationId: informationIdSchema.parse("candidate-upper"),
      kind: turnCandidateInformationKind.kind,
      occurredAt: outcome.occurredAt,
      source: "module:heartbeat.test",
      payload: {
        scopeKey: "qq:adapter:group:room",
        platform: "qq",
        adapterId: "adapter",
        destination: { kind: "group", groupId: "room" },
      },
      references: [],
    });
    const runtimeContext = freezeInformationAtom({
      informationId: informationIdSchema.parse("runtime-context-upper"),
      kind: "core.runtime.context",
      occurredAt: outcome.occurredAt,
      source: "runtime:test",
      payload: {},
      references: [],
    });
    const inbound = freezeInformationAtom({
      informationId: informationIdSchema.parse("inbound-before-upper"),
      kind: inboundTextInformationKind.kind,
      occurredAt: "2026-09-08T00:00:09.000Z",
      source: "adapter:test",
      payload: { text: "pending", source: {} },
      references: [],
    });
    const find = vi.fn(async (query: { kinds?: readonly string[] }) => {
      if (query.kinds?.includes(attentionArousalCompletedInformationKind.kind))
        return [outcome];
      if (query.kinds?.includes(turnContextCompletedInformationKind.kind))
        return [];
      if (query.kinds?.includes(inboundTextInformationKind.kind))
        return [inbound];
      return [];
    });
    const related = vi.fn(
      async (query: { from: readonly string[]; relation: string }) => {
        if (query.from.includes(outcome.informationId)) return [candidate];
        if (query.from.includes(candidate.informationId))
          return [runtimeContext];
        return [];
      },
    );

    await heartbeatDeferredObservationSelector.select({
      sourceAtom: state,
      ledger: { find, related },
    } as never);

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        kinds: [inboundTextInformationKind.kind],
        throughInformationId: "inbound-upper",
        registrationOrder: true,
        order: "asc",
      }),
    );
  });

  it("replaces the open generation and carries ordered source ids forward", async () => {
    const replace = vi.fn<OneShotScheduleCapability["replace"]>(async () => ({
      scheduleInformationId: informationIdSchema.parse("schedule-new"),
      created: true,
      previousOutcome: "superseded",
      previousTerminalInformationId: informationIdSchema.parse(
        "schedule-old-terminal",
      ),
    }));
    const oneShot: OneShotScheduleCapability = {
      schedule: async () => {
        throw new Error("unexpected schedule");
      },
      replace,
      finish: async () => {
        throw new Error("unexpected finish");
      },
    };
    const instance = await heartbeatModule.create(
      {
        instanceId: "heartbeat.test",
        settings: heartbeatSettingsSchema.parse({
          maxReplacementAttempts: 3,
          totalWaitBudget: 3,
        }),
        activation: {
          instanceId: "heartbeat.test",
          definitionId: heartbeatModule.manifest.definitionId,
        },
      },
      {
        signal: new AbortController().signal,
        now: () => new Date("2026-09-08T00:00:10.000Z"),
        report: async () => undefined,
        use: (capability) => {
          if (!Object.is(capability, oneShotScheduleCapability))
            throw new Error("unexpected capability");
          return oneShot as never;
        },
      },
    );
    const inbound = freezeInformationAtom({
      informationId: informationIdSchema.parse("inbound-2"),
      kind: inboundTextInformationKind.kind,
      occurredAt: "2026-09-08T00:00:10.000Z",
      source: "adapter:test",
      payload: { text: "second", source },
      references: [],
    });
    const previousSchedule = freezeInformationAtom({
      informationId: informationIdSchema.parse("schedule-old"),
      kind: oneShotRequestedInformationKind.kind,
      occurredAt: "2026-09-08T00:00:09.000Z",
      source: "core:scheduler",
      payload: {
        operationKey: "heartbeat:heartbeat-old",
        dueAt: "2026-09-08T00:00:10.500Z",
        input: {
          heartbeatInformationId: "heartbeat-old",
          scopeKey: "web:adapter:web:",
          reason: "message",
          sourceInformationIds: ["inbound-1"],
          wakeOnMessage: true,
          attempt: 0,
          totalWaitBudget: 0,
        },
        activation: {
          instanceId: "heartbeat.test",
          definitionId: heartbeatModule.manifest.definitionId,
        },
      },
      references: [],
    });
    const previousHeartbeat = freezeInformationAtom({
      informationId: informationIdSchema.parse("heartbeat-old"),
      kind: heartbeatScheduledInformationKind.kind,
      occurredAt: "2026-09-08T00:00:09.000Z",
      source: "module:heartbeat.test",
      payload: {},
      references: [],
    });
    const nextHeartbeat = freezeInformationAtom({
      informationId: informationIdSchema.parse("heartbeat-new"),
      kind: heartbeatScheduledInformationKind.kind,
      occurredAt: "2026-09-08T00:00:10.000Z",
      source: "module:heartbeat.test",
      payload: {},
      references: [],
    });
    const registerOnce = vi.fn(async () => nextHeartbeat);
    const commitTerminal = vi.fn(async () =>
      freezeInformationAtom({
        informationId: informationIdSchema.parse("heartbeat-old-terminal"),
        kind: heartbeatSupersededInformationKind.kind,
        occurredAt: "2026-09-08T00:00:10.000Z",
        source: "module:heartbeat.test",
        payload: { replacementInformationId: nextHeartbeat.informationId },
        references: [],
      }),
    );

    const messageSubscription = instance.subscriptions.find(
      ({ subscriptionId }) => subscriptionId === "heartbeat.message",
    )!;
    await messageSubscription.handle(inbound, {
      signal: new AbortController().signal,
      definitionId: heartbeatModule.manifest.definitionId,
      instanceId: "heartbeat.test",
      sourceAtom: inbound,
      now: () => new Date("2026-09-08T00:00:10.000Z"),
      report: async () => undefined,
      use: () => oneShot as never,
      select: async () => [previousSchedule, previousHeartbeat],
      register: async () => {
        throw new Error("unexpected register");
      },
      registerOnce,
      commitTerminal,
    } as never);

    expect(registerOnce).toHaveBeenCalledWith(
      "agent.attention.arousal.activity",
      inbound.informationId,
      attentionArousalActivityInformationKind,
      {
        payload: {
          inboundInformationId: inbound.informationId,
          observedAt: "2026-09-08T00:00:10.000Z",
          policyVersion: "attention-activity.v1",
        },
        references: [],
      },
    );
    expect(registerOnce).toHaveBeenCalledWith(
      "agent.heartbeat.scheduled",
      inbound.informationId,
      heartbeatScheduledInformationKind,
      expect.objectContaining({
        payload: expect.objectContaining({
          sourceInformationIds: ["inbound-1", "inbound-2"],
          dueAt: "2026-09-08T00:00:10.000Z",
          scopeKey: "web:adapter:web:",
        }),
        references: [
          { relation: "core:uses-context", informationId: "inbound-1" },
          { relation: "core:uses-context", informationId: "inbound-2" },
        ],
      }),
    );
    expect(replace).toHaveBeenCalledWith(
      expect.objectContaining({
        operationKey: "heartbeat:heartbeat-new",
        sourceInformationId: "heartbeat-new",
        previousScheduleInformationId: "schedule-old",
        input: expect.objectContaining({
          sourceInformationIds: ["inbound-1", "inbound-2"],
        }),
      }),
    );
    expect(commitTerminal).toHaveBeenCalledWith(
      "agent.heartbeat",
      "heartbeat-old",
      heartbeatSupersededInformationKind,
      {
        payload: { replacementInformationId: "heartbeat-new" },
        references: [
          { relation: "core:status-of", informationId: "heartbeat-old" },
        ],
      },
    );
  });
});
