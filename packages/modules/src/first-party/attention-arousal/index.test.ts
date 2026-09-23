import { freezeInformationAtom, informationIdSchema } from "@kaguya/schema";
import {
  oneShotDueInformationKind,
  oneShotRequestedInformationKind,
  oneShotScheduleCapability,
  type OneShotScheduleCapability,
} from "@kaguya/scheduler";
import { describe, expect, it, vi } from "vitest";

import {
  attentionArousalModule,
  attentionArousalSettingsSchema,
  attentionArousalStateSelector,
  attentionArousalTimerSelector,
  createAttentionArousalModule,
  decideAttentionArousal,
  isNightSleepTime,
  localTimeOfDay,
  nextLocalTimeOccurrence,
} from "./index.js";
import {
  attentionArousalActivityInformationKind,
  attentionArousalCompletedInformationKind,
  attentionArousalStateRecordedInformationKind,
  turnCandidateInformationKind,
} from "../information-kinds.js";

describe("attention observation policy", () => {
  it.each(["private", "web", "mention-self", "mention-all", "reply-self"])(
    "observes a direct %s signal",
    (signal) => {
      expect(
        decideAttentionArousal({ signals: [signal], focusActive: false }),
      ).toEqual({
        outcome: "observe",
        reasonCodes: [signal],
        arousalState: "awake",
        wakeSignal: true,
      });
    },
  );

  it("observes Focus and periodic rechecks even while asleep", () => {
    expect(
      decideAttentionArousal({
        signals: ["passive"],
        focusActive: true,
        arousalState: "asleep",
      }),
    ).toMatchObject({
      outcome: "observe",
      reasonCodes: ["focus-active"],
      arousalState: "awake",
      wakeSignal: true,
    });
    expect(
      decideAttentionArousal({
        signals: ["recheck"],
        focusActive: false,
        arousalState: "asleep",
      }),
    ).toMatchObject({
      outcome: "observe",
      reasonCodes: ["periodic-recheck"],
      arousalState: "awake",
      wakeSignal: true,
    });
  });

  it("defaults to awake and defers only passive opportunities while asleep", () => {
    expect(
      decideAttentionArousal({ signals: ["passive"], focusActive: false }),
    ).toEqual({
      outcome: "observe",
      reasonCodes: ["arousal-awake"],
      arousalState: "awake",
      wakeSignal: false,
    });
    expect(
      decideAttentionArousal({
        signals: ["passive"],
        focusActive: false,
        arousalState: "asleep",
      }),
    ).toEqual({
      outcome: "defer",
      reasonCodes: ["arousal-asleep"],
      arousalState: "asleep",
      wakeSignal: false,
    });
  });

  it("uses one-shot deadlines rather than ticks or heartbeat counters", () => {
    expect(attentionArousalSettingsSchema.parse({})).toEqual({
      idleSleepEnabled: false,
      idleSleepAfterMs: 120_000,
      nightSleepEnabled: false,
      nightSleepStart: "23:00",
      nightSleepEnd: "07:00",
      periodicWakeEnabled: true,
      periodicWakeEveryMs: 300_000,
    });
    expect(() =>
      attentionArousalSettingsSchema.parse({ idleSleepAfterHeartbeats: 24 }),
    ).toThrow();
    expect(
      attentionArousalModule.manifest.selectors.map(
        ({ selectorId }) => selectorId,
      ),
    ).toEqual([
      "agent.attention.focus.state",
      attentionArousalStateSelector.selectorId,
      attentionArousalTimerSelector.selectorId,
    ]);
    expect(
      attentionArousalModule.manifest.consumes.map(({ kind }) => kind),
    ).toEqual([
      turnCandidateInformationKind.kind,
      attentionArousalActivityInformationKind.kind,
      oneShotDueInformationKind.kind,
    ]);
    expect(attentionArousalModule.manifest.requires).toEqual([
      expect.objectContaining({ id: "kaguya:schedule.one-shot" }),
    ]);
  });

  it("computes night windows and their next absolute boundary", () => {
    const settings = attentionArousalSettingsSchema.parse({
      nightSleepEnabled: true,
    });
    expect(localTimeOfDay("2026-09-22T15:00:00.000Z", "Asia/Shanghai")).toBe(
      "23:00",
    );
    expect(isNightSleepTime("23:00", settings)).toBe(true);
    expect(isNightSleepTime("06:59", settings)).toBe(true);
    expect(isNightSleepTime("07:00", settings)).toBe(false);
    expect(
      nextLocalTimeOccurrence(
        "2026-09-22T14:59:30.000Z",
        "23:00",
        "Asia/Shanghai",
      ),
    ).toBe("2026-09-22T15:00:00.000Z");
  });

  it("resets idle sleep with one absolute one-shot on message activity", async () => {
    const schedule = vi.fn<OneShotScheduleCapability["schedule"]>(async () => ({
      scheduleInformationId: informationIdSchema.parse("idle-schedule-1"),
      created: true,
    }));
    const scheduler: OneShotScheduleCapability = {
      schedule,
      replace: async () => {
        throw new Error("unexpected replace");
      },
      finish: async () => {
        throw new Error("unexpected finish");
      },
    };
    const module = createAttentionArousalModule({ timeZone: "Asia/Shanghai" });
    const instance = await module.create(
      {
        instanceId: "arousal.test",
        activation: {
          instanceId: "arousal.test",
          definitionId: module.manifest.definitionId,
        },
        settings: attentionArousalSettingsSchema.parse({
          idleSleepEnabled: true,
        }),
      },
      {
        signal: new AbortController().signal,
        now: () => new Date("2026-09-22T08:00:00.000Z"),
        report: async () => undefined,
        use: (capability) => {
          if (!Object.is(capability, oneShotScheduleCapability))
            throw new Error("unexpected capability");
          return scheduler as never;
        },
      },
    );
    const activity = freezeInformationAtom({
      informationId: informationIdSchema.parse("activity-1"),
      kind: attentionArousalActivityInformationKind.kind,
      occurredAt: "2026-09-22T08:00:00.000Z",
      source: "module:heartbeat.test",
      payload: {
        inboundInformationId: "inbound-1",
        observedAt: "2026-09-22T07:59:30.000Z",
        policyVersion: "attention-activity.v1",
      },
      references: [],
    });
    const state = freezeInformationAtom({
      informationId: informationIdSchema.parse("state-1"),
      kind: attentionArousalStateRecordedInformationKind.kind,
      occurredAt: "2026-09-22T08:00:00.000Z",
      source: "module:arousal.test",
      payload: {
        state: "awake",
        cause: "activity",
        activityInformationId: activity.informationId,
        lastEvaluatedAt: "2026-09-22T08:00:00.000Z",
        lastInboundInformationId: "inbound-1",
        lastActivityAt: "2026-09-22T07:59:30.000Z",
        sleepStartedAt: null,
        lastPeriodicWakeAt: null,
        reasonCodes: ["global-message-activity"],
        policyVersion: "attention-observation.v1",
      },
      references: [],
    });
    const registerOnce = vi.fn(async () => state);
    const subscription = instance.subscriptions.find(
      ({ subscriptionId }) => subscriptionId === "attention-arousal.activity",
    )!;
    await subscription.handle(activity, {
      instanceId: "arousal.test",
      now: () => new Date("2026-09-22T08:00:00.000Z"),
      select: async () => [],
      registerOnce,
    } as never);

    expect(registerOnce).toHaveBeenCalledWith(
      "agent.attention.arousal.activity",
      activity.informationId,
      attentionArousalStateRecordedInformationKind,
      expect.objectContaining({
        payload: expect.objectContaining({
          state: "awake",
          lastActivityAt: activity.payload.observedAt,
        }),
      }),
    );
    expect(schedule).toHaveBeenCalledOnce();
    expect(schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        dueAt: "2026-09-22T08:01:30.000Z",
        input: { purpose: "idle-sleep" },
      }),
    );
  });

  it("records activity without waking an already sleeping bot", async () => {
    const schedule = vi.fn<OneShotScheduleCapability["schedule"]>(async () => ({
      scheduleInformationId: informationIdSchema.parse("periodic-after-input"),
      created: true,
    }));
    const scheduler: OneShotScheduleCapability = {
      schedule,
      replace: async () => {
        throw new Error("unexpected replace");
      },
      finish: async () => {
        throw new Error("unexpected finish");
      },
    };
    const module = createAttentionArousalModule({ timeZone: "Asia/Shanghai" });
    const instance = await module.create(
      {
        instanceId: "arousal.test",
        activation: {
          instanceId: "arousal.test",
          definitionId: module.manifest.definitionId,
        },
        settings: attentionArousalSettingsSchema.parse({}),
      },
      {
        signal: new AbortController().signal,
        now: () => new Date("2026-09-22T08:00:00.000Z"),
        report: async () => undefined,
        use: () => scheduler as never,
      },
    );
    const previous = freezeInformationAtom({
      informationId: informationIdSchema.parse("state-sleeping"),
      kind: attentionArousalStateRecordedInformationKind.kind,
      occurredAt: "2026-09-22T07:59:00.000Z",
      source: "module:arousal.test",
      payload: {
        state: "asleep",
        cause: "timer",
        timerInformationId: "idle-due",
        lastEvaluatedAt: "2026-09-22T07:59:00.000Z",
        lastInboundInformationId: null,
        lastActivityAt: "2026-09-22T07:57:00.000Z",
        sleepStartedAt: "2026-09-22T07:59:00.000Z",
        lastPeriodicWakeAt: null,
        reasonCodes: ["global-idle-sleep"],
        policyVersion: "attention-observation.v1",
      },
      references: [],
    });
    const activity = freezeInformationAtom({
      informationId: informationIdSchema.parse("activity-sleeping"),
      kind: attentionArousalActivityInformationKind.kind,
      occurredAt: "2026-09-22T08:00:00.000Z",
      source: "module:heartbeat.test",
      payload: {
        inboundInformationId: "inbound-sleeping",
        observedAt: "2026-09-22T08:00:00.000Z",
        policyVersion: "attention-activity.v1",
      },
      references: [],
    });
    const recorded = freezeInformationAtom({
      ...previous,
      informationId: informationIdSchema.parse("state-still-sleeping"),
      payload: {
        ...previous.payload,
        cause: "activity",
        activityInformationId: activity.informationId,
        lastInboundInformationId: activity.payload.inboundInformationId,
        lastActivityAt: activity.payload.observedAt,
        reasonCodes: ["global-message-activity"],
      },
      references: [],
    });
    const registerOnce = vi.fn(async () => recorded);
    const subscription = instance.subscriptions.find(
      ({ subscriptionId }) => subscriptionId === "attention-arousal.activity",
    )!;
    await subscription.handle(activity, {
      instanceId: "arousal.test",
      now: () => new Date(activity.occurredAt),
      select: async (selector: { selectorId: string }) =>
        selector.selectorId === attentionArousalStateSelector.selectorId
          ? [previous]
          : [],
      registerOnce,
    } as never);

    expect(registerOnce).toHaveBeenCalledWith(
      "agent.attention.arousal.activity",
      activity.informationId,
      attentionArousalStateRecordedInformationKind,
      expect.objectContaining({
        payload: expect.objectContaining({
          state: "asleep",
          lastInboundInformationId: activity.payload.inboundInformationId,
          lastActivityAt: activity.payload.observedAt,
        }),
      }),
    );
    expect(schedule).toHaveBeenCalledWith(
      expect.objectContaining({ input: { purpose: "periodic-wake" } }),
    );
  });

  it("does not postpone an open periodic wake when night messages keep arriving", async () => {
    const schedule = vi.fn<OneShotScheduleCapability["schedule"]>(async () => ({
      scheduleInformationId: informationIdSchema.parse("night-boundary-1"),
      created: true,
    }));
    const replace = vi.fn<OneShotScheduleCapability["replace"]>();
    const scheduler: OneShotScheduleCapability = {
      schedule,
      replace,
      finish: async () => {
        throw new Error("unexpected finish");
      },
    };
    const module = createAttentionArousalModule({ timeZone: "Asia/Shanghai" });
    const instance = await module.create(
      {
        instanceId: "arousal.test",
        activation: {
          instanceId: "arousal.test",
          definitionId: module.manifest.definitionId,
        },
        settings: attentionArousalSettingsSchema.parse({
          nightSleepEnabled: true,
          nightSleepStart: "00:00",
          nightSleepEnd: "23:59",
        }),
      },
      {
        signal: new AbortController().signal,
        now: () => new Date("2026-09-22T08:00:00.000Z"),
        report: async () => undefined,
        use: () => scheduler as never,
      },
    );
    const activity = freezeInformationAtom({
      informationId: informationIdSchema.parse("activity-night"),
      kind: attentionArousalActivityInformationKind.kind,
      occurredAt: "2026-09-22T08:00:00.000Z",
      source: "module:heartbeat.test",
      payload: {
        inboundInformationId: "inbound-night",
        observedAt: "2026-09-22T08:00:00.000Z",
        policyVersion: "attention-activity.v1",
      },
      references: [],
    });
    const state = freezeInformationAtom({
      informationId: informationIdSchema.parse("state-night"),
      kind: attentionArousalStateRecordedInformationKind.kind,
      occurredAt: activity.occurredAt,
      source: "module:arousal.test",
      payload: {
        state: "asleep",
        cause: "activity",
        activityInformationId: activity.informationId,
        lastEvaluatedAt: activity.occurredAt,
        lastInboundInformationId: activity.payload.inboundInformationId,
        lastActivityAt: activity.payload.observedAt,
        sleepStartedAt: activity.occurredAt,
        lastPeriodicWakeAt: null,
        reasonCodes: ["night-sleep"],
        policyVersion: "attention-observation.v1",
      },
      references: [],
    });
    const periodic = freezeInformationAtom({
      informationId: informationIdSchema.parse("periodic-open"),
      kind: oneShotRequestedInformationKind.kind,
      occurredAt: activity.occurredAt,
      source: "core:scheduler",
      payload: {
        operationKey: "arousal:periodic-wake:older-state",
        dueAt: "2026-09-22T08:04:00.000Z",
        input: { purpose: "periodic-wake" },
        activation: {
          instanceId: "arousal.test",
          definitionId: module.manifest.definitionId,
        },
      },
      references: [],
    });
    const subscription = instance.subscriptions.find(
      ({ subscriptionId }) => subscriptionId === "attention-arousal.activity",
    )!;
    await subscription.handle(activity, {
      instanceId: "arousal.test",
      now: () => new Date(activity.occurredAt),
      select: async (selector: { selectorId: string }) =>
        selector.selectorId === attentionArousalStateSelector.selectorId
          ? [state]
          : [periodic],
      registerOnce: async () => state,
    } as never);

    expect(replace).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledOnce();
    expect(schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { purpose: "night-boundary", boundary: "end" },
      }),
    );
  });

  it("enters sleep when the idle deadline fires and arms one periodic wake", async () => {
    const schedule = vi.fn<OneShotScheduleCapability["schedule"]>(async () => ({
      scheduleInformationId: informationIdSchema.parse("periodic-next"),
      created: true,
    }));
    const finish = vi.fn<OneShotScheduleCapability["finish"]>(async () => ({
      scheduleInformationId: informationIdSchema.parse("idle-open"),
      terminalInformationId: informationIdSchema.parse("idle-fired"),
      status: "fired",
      created: true,
    }));
    const scheduler: OneShotScheduleCapability = {
      schedule,
      replace: async () => {
        throw new Error("unexpected replace");
      },
      finish,
    };
    const module = createAttentionArousalModule({ timeZone: "Asia/Shanghai" });
    const instance = await module.create(
      {
        instanceId: "arousal.test",
        activation: {
          instanceId: "arousal.test",
          definitionId: module.manifest.definitionId,
        },
        settings: attentionArousalSettingsSchema.parse({
          idleSleepEnabled: true,
        }),
      },
      {
        signal: new AbortController().signal,
        now: () => new Date("2026-09-22T08:02:00.000Z"),
        report: async () => undefined,
        use: () => scheduler as never,
      },
    );
    const previous = freezeInformationAtom({
      informationId: informationIdSchema.parse("state-awake"),
      kind: attentionArousalStateRecordedInformationKind.kind,
      occurredAt: "2026-09-22T08:00:00.000Z",
      source: "module:arousal.test",
      payload: {
        state: "awake",
        cause: "activity",
        activityInformationId: "activity-idle",
        lastEvaluatedAt: "2026-09-22T08:00:00.000Z",
        lastInboundInformationId: "inbound-idle",
        lastActivityAt: "2026-09-22T08:00:00.000Z",
        sleepStartedAt: null,
        lastPeriodicWakeAt: null,
        reasonCodes: ["global-message-activity"],
        policyVersion: "attention-observation.v1",
      },
      references: [],
    });
    const request = freezeInformationAtom({
      informationId: informationIdSchema.parse("idle-open"),
      kind: oneShotRequestedInformationKind.kind,
      occurredAt: previous.occurredAt,
      source: "core:scheduler",
      payload: {
        operationKey: "arousal:idle-sleep:state-awake",
        dueAt: "2026-09-22T08:02:00.000Z",
        input: { purpose: "idle-sleep" },
        activation: {
          instanceId: "arousal.test",
          definitionId: module.manifest.definitionId,
        },
      },
      references: [],
    });
    const due = freezeInformationAtom({
      informationId: informationIdSchema.parse("idle-due"),
      kind: oneShotDueInformationKind.kind,
      occurredAt: request.payload.dueAt,
      source: "core:scheduler",
      payload: {
        scheduleInformationId: request.informationId,
        dueAt: request.payload.dueAt,
        deliveredAt: request.payload.dueAt,
      },
      references: [],
    });
    const asleep = freezeInformationAtom({
      informationId: informationIdSchema.parse("state-asleep"),
      kind: attentionArousalStateRecordedInformationKind.kind,
      occurredAt: due.occurredAt,
      source: "module:arousal.test",
      payload: {
        state: "asleep",
        cause: "timer",
        timerInformationId: due.informationId,
        lastEvaluatedAt: due.occurredAt,
        lastInboundInformationId: "inbound-idle",
        lastActivityAt: previous.payload.lastActivityAt,
        sleepStartedAt: due.occurredAt,
        lastPeriodicWakeAt: null,
        reasonCodes: ["global-idle-sleep"],
        policyVersion: "attention-observation.v1",
      },
      references: [],
    });
    const registerOnce = vi.fn(async () => asleep);
    const subscription = instance.subscriptions.find(
      ({ subscriptionId }) => subscriptionId === "attention-arousal.timer",
    )!;
    await subscription.handle(due, {
      instanceId: "arousal.test",
      now: () => new Date(due.occurredAt),
      select: async () => [request, previous],
      registerOnce,
    } as never);

    expect(finish).toHaveBeenCalledWith({
      scheduleInformationId: request.informationId,
      status: "fired",
    });
    expect(registerOnce).toHaveBeenCalledWith(
      "agent.attention.arousal.timer",
      due.informationId,
      attentionArousalStateRecordedInformationKind,
      expect.objectContaining({
        payload: expect.objectContaining({
          state: "asleep",
          reasonCodes: ["global-idle-sleep"],
        }),
      }),
    );
    expect(schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        dueAt: "2026-09-22T08:07:00.000Z",
        input: { purpose: "periodic-wake" },
      }),
    );
  });

  it("accepts only the strict observation record", () => {
    const payload = {
      outcome: "observe",
      arousalState: "awake",
      arousalStateInformationId: "arousal-state-1",
      wakeSignal: true,
      candidateInformationId: "candidate-1",
      scopeKey: "qq:bot:group:room",
      unreadThroughInformationId: "inbound-2",
      unreadCount: 2,
      signals: ["mention-self"],
      focusState: "inactive",
      reasonCodes: ["mention-self"],
      policyVersion: "attention-observation.v1",
    };
    expect(
      attentionArousalCompletedInformationKind.payloadSchema.parse(payload),
    ).toEqual(payload);
    expect(() =>
      attentionArousalCompletedInformationKind.payloadSchema.parse({
        ...payload,
        text: "正文不得进入 Arousal",
      }),
    ).toThrow();
    expect(() =>
      attentionArousalCompletedInformationKind.payloadSchema.parse({
        ...payload,
        score: 100,
      }),
    ).toThrow();
  });

  it("keeps state and activity facts strict and timestamp based", () => {
    const state = {
      state: "awake",
      cause: "activity",
      activityInformationId: "activity-1",
      lastEvaluatedAt: "2026-09-22T08:00:00.000Z",
      lastInboundInformationId: "inbound-1",
      lastActivityAt: "2026-09-22T08:00:00.000Z",
      sleepStartedAt: null,
      lastPeriodicWakeAt: null,
      reasonCodes: ["global-message-activity"],
      policyVersion: "attention-observation.v1",
    };
    expect(
      attentionArousalStateRecordedInformationKind.payloadSchema.parse(state),
    ).toEqual(state);
    expect(() =>
      attentionArousalStateRecordedInformationKind.payloadSchema.parse({
        ...state,
        lastHeartbeatIndex: 12,
      }),
    ).toThrow();

    const activity = {
      inboundInformationId: "inbound-1",
      observedAt: "2026-09-22T08:00:00.000Z",
      policyVersion: "attention-activity.v1",
    };
    expect(
      attentionArousalActivityInformationKind.payloadSchema.parse(activity),
    ).toEqual(activity);
    expect(() =>
      attentionArousalActivityInformationKind.payloadSchema.parse({
        ...activity,
        text: "正文",
      }),
    ).toThrow();
  });

  it("keeps candidate payloads non-semantic", () => {
    const payload = {
      triggerInformationId: "inbound-2",
      reason: "message",
      dueAt: "2026-09-22T08:00:00.000Z",
      firedAt: "2026-09-22T08:00:00.000Z",
      platform: "qq",
      adapterId: "bot",
      destination: { kind: "group", groupId: "room" },
      unreadThroughInformationId: "inbound-2",
      unreadCount: 2,
      signals: ["passive"],
      scopeKey: "qq:bot:group:room",
      asOf: "2026-09-22T08:00:00.000Z",
      policyVersion: "attention-opportunity.v1",
      rebuildAttempt: 0,
      attempt: 0,
      totalWaitBudget: 3,
    };
    expect(turnCandidateInformationKind.payloadSchema.parse(payload)).toEqual(
      payload,
    );
    for (const semantic of [
      { text: "正文" },
      { sourceInformationIds: ["inbound-1", "inbound-2"] },
      { score: 80 },
    ])
      expect(() =>
        turnCandidateInformationKind.payloadSchema.parse({
          ...payload,
          ...semantic,
        }),
      ).toThrow();
  });
});
