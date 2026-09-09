import { freezeInformationAtom, informationIdSchema } from "@kaguya/schema";
import {
  oneShotRequestedInformationKind,
  oneShotScheduleCapability,
  type OneShotScheduleCapability,
} from "@kaguya/scheduler";
import { describe, expect, it, vi } from "vitest";

import { heartbeatModule, heartbeatSettingsSchema } from "./index.js";
import {
  heartbeatScheduledInformationKind,
  heartbeatSupersededInformationKind,
  inboundTextInformationKind,
} from "../information-kinds.js";

const source = {
  adapterId: "adapter",
  platform: "web",
  platformMessageId: "message-2",
  destination: { kind: "web" as const },
  senderId: "web",
};

describe("heartbeatModule", () => {
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
        settings: heartbeatSettingsSchema.parse({ messageDebounceMs: 1_500 }),
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

    await instance.subscriptions[0]!.handle(inbound, {
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
      "agent.heartbeat.scheduled",
      inbound.informationId,
      heartbeatScheduledInformationKind,
      expect.objectContaining({
        payload: expect.objectContaining({
          sourceInformationIds: ["inbound-1", "inbound-2"],
          dueAt: "2026-09-08T00:00:11.500Z",
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
