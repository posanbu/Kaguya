import { z } from "@kaguya/schema";
import {
  defineInformationModule,
  defineInformationSelector,
  onInformation,
} from "@kaguya/sdk";
import {
  oneShotDueInformationKind,
  oneShotScheduleCapability,
  oneShotRequestedInformationKind,
} from "@kaguya/scheduler";
import {
  heartbeatScheduledInformationKind,
  heartbeatFiredInformationKind,
  heartbeatSupersededInformationKind,
  heartbeatFailedInformationKind,
  turnCandidateInformationKind,
  inboundTextInformationKind,
  waitRequestedInformationKind,
} from "./information-kinds.js";

export const heartbeatSettingsSchema = z
  .object({
    messageDebounceMs: z.number().int().min(0).default(1500),
    maxReplacementAttempts: z.number().int().min(1).max(20).default(3),
  })
  .strict();
export type HeartbeatSettings = z.infer<typeof heartbeatSettingsSchema>;
function scopeOf(source: any): string {
  const d = source.destination ?? {};
  const id = d.groupId ?? d.userId ?? d.channelId ?? d.id ?? "";
  return `${source.platform}:${source.adapterId}:${d.kind ?? "unknown"}:${id}`;
}

export const heartbeatScopeSelector = defineInformationSelector({
  selectorId: "agent.heartbeat.scope-schedules",
  select: async ({ sourceAtom, ledger }) => {
    const source = (sourceAtom.payload as any).source;
    const scopeKey = source
      ? scopeOf(source)
      : (sourceAtom.payload as any).scopeKey;
    const schedules = await ledger.find({
      kinds: [oneShotRequestedInformationKind.kind],
      limit: 5000,
    });
    const result: string[] = [];
    for (const schedule of schedules) {
      const input = (schedule.payload as any).input;
      if (!input || input.scopeKey !== scopeKey) continue;
      const terminal = await ledger.related({
        from: [schedule.informationId],
        relation: "core:status-of",
        direction: "incoming",
        limit: 1,
      });
      if (!terminal.length) result.push(schedule.informationId);
    }
    return result;
  },
});
export const heartbeatDueSelector = defineInformationSelector({
  selectorId: "agent.heartbeat.due-source",
  select: async ({ sourceAtom, ledger }) => {
    const requested = await ledger.related({
      from: [sourceAtom.informationId],
      relation: "core:status-of",
      direction: "outgoing",
      limit: 1,
    });
    if (!requested.length) return [];
    return (
      await ledger.related({
        from: [requested[0]!.informationId],
        relation: "core:caused-by",
        direction: "outgoing",
        limit: 1,
      })
    ).map((a) => a.informationId);
  },
});

export const heartbeatModule = defineInformationModule({
  manifest: {
    protocolVersion: 1,
    moduleVersion: "1.0.0",
    definitionId: "agent.heartbeat.short",
    displayName: "Durable short heartbeat",
    settingsSchema: heartbeatSettingsSchema,
    consumes: [
      inboundTextInformationKind,
      waitRequestedInformationKind,
      oneShotDueInformationKind,
    ],
    produces: [
      heartbeatScheduledInformationKind,
      heartbeatFiredInformationKind,
      heartbeatSupersededInformationKind,
      heartbeatFailedInformationKind,
      turnCandidateInformationKind,
    ],
    selectors: [heartbeatScopeSelector, heartbeatDueSelector],
    promptRenderers: [],
    requires: [oneShotScheduleCapability],
    provides: [],
  },
  create: ({ settings }, lifecycle) => {
    const oneShot = lifecycle.use(oneShotScheduleCapability);
    const schedule = async (
      atom: any,
      context: any,
      reason: "message" | "wait",
      dueAt: string,
      sourceIds: string[],
      wakeOnMessage: boolean,
      attempt: number,
      totalWaitBudget: number,
      previous?: string,
    ) => {
      const source = (atom.payload as any).source;
      if (!source) return;
      const scopeKey = scopeOf(source);
      const heartbeat = await context.register(
        heartbeatScheduledInformationKind,
        {
          payload: {
            reason,
            dueAt,
            policyVersion: "short-heartbeat.v1",
            platform: source.platform,
            adapterId: source.adapterId,
            destination: source.destination,
            sourceInformationIds: sourceIds,
            wakeOnMessage,
            attempt,
            totalWaitBudget,
            scopeKey,
          },
        },
      );
      const input = {
        heartbeatInformationId: heartbeat.informationId,
        scopeKey,
        reason,
        sourceInformationIds: sourceIds,
        wakeOnMessage,
        attempt,
        totalWaitBudget,
      };
      const activation = {
        instanceId: context.instanceId,
        definitionId: "agent.heartbeat.short",
      };
      try {
        if (previous) {
          const receipt = await oneShot.replace({
            operationKey: `heartbeat:${scopeKey}`,
            sourceInformationId: heartbeat.informationId,
            previousScheduleInformationId: previous,
            dueAt,
            input,
            activation,
          });
          if (receipt.previousOutcome === "superseded")
            await context.commitTerminal(
              "agent.heartbeat",
              previous,
              heartbeatSupersededInformationKind,
              {
                payload: { replacementInformationId: heartbeat.informationId },
              },
            );
        } else
          await oneShot.schedule({
            operationKey: `heartbeat:${scopeKey}`,
            sourceInformationId: heartbeat.informationId,
            dueAt,
            input,
            activation,
          });
      } catch {
        await context.commitTerminal(
          "agent.heartbeat",
          heartbeat.informationId,
          heartbeatFailedInformationKind,
          { payload: { error: "one-shot scheduling failed" } },
        );
      }
    };
    return {
      provisions: [],
      describeStartup: () => ({
        summary: "Durable short heartbeat ready",
        fields: {
          messageDebounceMs: settings.messageDebounceMs,
          maxReplacementAttempts: settings.maxReplacementAttempts,
          policyVersion: "short-heartbeat.v1",
        },
      }),
      subscriptions: [
        onInformation(
          inboundTextInformationKind,
          { subscriptionId: "heartbeat.message", delivery: "durable" },
          async (atom, context) => {
            const open = await context.select(heartbeatScopeSelector);
            const previous = open[0] as any;
            const previousInput = previous?.payload?.input as any;
            const preserveWait =
              previousInput?.reason === "wait" &&
              previousInput?.wakeOnMessage === false;
            const dueAt = preserveWait
              ? previous.payload.dueAt
              : new Date(
                  context.now().getTime() + settings.messageDebounceMs,
                ).toISOString();
            const reason = preserveWait ? "wait" : "message";
            const sourceIds = [
              ...(Array.isArray(previousInput?.sourceInformationIds)
                ? previousInput.sourceInformationIds
                : []),
              atom.informationId,
            ];
            await schedule(
              atom,
              context,
              reason,
              dueAt,
              sourceIds,
              preserveWait ? false : true,
              previousInput?.attempt ?? 0,
              previousInput?.totalWaitBudget ?? 0,
              previous?.informationId,
            );
          },
        ),
        onInformation(
          waitRequestedInformationKind,
          { subscriptionId: "heartbeat.wait", delivery: "durable" },
          async (atom, context) => {
            const p = atom.payload as any;
            await schedule(
              atom,
              context,
              "wait",
              p.dueAt,
              [atom.informationId],
              p.wakeOnMessage,
              p.attempt,
              p.totalWaitBudget,
            );
          },
        ),
        onInformation(
          oneShotDueInformationKind,
          { subscriptionId: "heartbeat.due", delivery: "durable" },
          async (atom, context) => {
            const candidates = await context.select(heartbeatDueSelector);
            const hb = candidates[0];
            if (!hb) return;
            let result;
            try {
              result = await oneShot.finish({
                scheduleInformationId: (atom.payload as any)
                  .scheduleInformationId,
                status: "fired",
              });
            } catch {
              await context.commitTerminal(
                "agent.heartbeat",
                hb.informationId,
                heartbeatFailedInformationKind,
                { payload: { error: "one-shot firing failed" } },
              );
              return;
            }
            if (result.status === "fired") {
              const fired = await context.commitTerminal(
                "agent.heartbeat",
                hb.informationId,
                heartbeatFiredInformationKind,
                { payload: { firedAt: context.now().toISOString() } },
              );
              const p: any = hb.payload;
              await context.registerOnce(
                "agent.turn.candidate",
                hb.informationId,
                turnCandidateInformationKind,
                {
                  payload: {
                    heartbeatInformationId: hb.informationId,
                    reason: p.reason,
                    dueAt: p.dueAt,
                    firedAt: context.now().toISOString(),
                    platform: p.platform,
                    adapterId: p.adapterId,
                    destination: p.destination,
                    sourceInformationIds: p.sourceInformationIds,
                    scopeKey: p.scopeKey,
                  },
                  references: [
                    {
                      relation: "agent:heartbeat-fired",
                      informationId: fired.informationId,
                    },
                  ],
                },
              );
            }
          },
        ),
      ],
    };
  },
});
