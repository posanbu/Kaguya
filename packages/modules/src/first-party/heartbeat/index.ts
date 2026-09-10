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
} from "../information-kinds.js";

export const heartbeatSettingsSchema = z
  .object({
    messageDebounceMs: z.number().int().min(0).default(1500),
    maxReplacementAttempts: z.number().int().min(1).max(20).default(3),
    totalWaitBudget: z.number().int().min(0).max(20).default(3),
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
      payloadContains: { input: { scopeKey } },
      order: "desc",
      limit: 1_000,
    });
    for (const schedule of schedules) {
      const input = (schedule.payload as any).input;
      if (!input || input.scopeKey !== scopeKey) continue;
      const terminal = await ledger.related({
        from: [schedule.informationId],
        relation: "core:status-of",
        direction: "incoming",
        limit: 1,
      });
      if (terminal.length) continue;
      const heartbeat = (
        await ledger.related({
          from: [schedule.informationId],
          relation: "core:caused-by",
          direction: "outgoing",
          limit: 1,
        })
      )[0];
      return heartbeat === undefined
        ? [schedule.informationId]
        : [schedule.informationId, heartbeat.informationId];
    }
    return [];
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
    const heartbeat = (
      await ledger.related({
        from: [requested[0]!.informationId],
        relation: "core:caused-by",
        direction: "outgoing",
        limit: 1,
      })
    )[0];
    if (heartbeat === undefined) return [];
    const runtimeContext = await ledger.related({
      from: [heartbeat.informationId],
      relation: "core:context",
      direction: "outgoing",
      limit: 1,
    });
    return [
      heartbeat.informationId,
      ...runtimeContext.map((a) => a.informationId),
    ];
  },
});

export const heartbeatModule = defineInformationModule({
  manifest: {
    protocolVersion: 2,
    moduleVersion: "1.0.0",
    definitionId: "agent.heartbeat.short",
    displayName: "Durable short heartbeat",
    summary: "Debounces and durably reawakens pending agent turns.",
    description:
      "Durably debounces inbound and wait signals into recoverable turn candidates. Scheduling remains a capability boundary: this module owns aggregation semantics while the Scheduler owns persistence and firing.",
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
      previousScheduleInformationId?: string,
      previousHeartbeatInformationId?: string,
    ) => {
      const source = (atom.payload as any).source;
      if (!source) return;
      const scopeKey = scopeOf(source);
      const orderedSourceIds = [...new Set(sourceIds)];
      const asOf = reason === "message" ? atom.occurredAt : dueAt;
      const heartbeat = await context.registerOnce(
        "agent.heartbeat.scheduled",
        atom.informationId,
        heartbeatScheduledInformationKind,
        {
          payload: {
            reason,
            dueAt,
            policyVersion: "short-heartbeat.v1",
            platform: source.platform,
            adapterId: source.adapterId,
            destination: source.destination,
            sourceInformationIds: orderedSourceIds,
            wakeOnMessage,
            attempt,
            totalWaitBudget,
            scopeKey,
            asOf,
          },
          references: orderedSourceIds.map((informationId) => ({
            relation: "core:uses-context",
            informationId,
          })),
        },
      );
      const input = {
        heartbeatInformationId: heartbeat.informationId,
        scopeKey,
        reason,
        sourceInformationIds: orderedSourceIds,
        wakeOnMessage,
        attempt,
        totalWaitBudget,
      };
      const activation = {
        instanceId: context.instanceId,
        definitionId: "agent.heartbeat.short",
      };
      try {
        if (previousScheduleInformationId) {
          const receipt = await oneShot.replace({
            operationKey: `heartbeat:${heartbeat.informationId}`,
            sourceInformationId: heartbeat.informationId,
            previousScheduleInformationId,
            dueAt,
            input,
            activation,
          });
          if (
            receipt.previousOutcome === "superseded" &&
            previousHeartbeatInformationId !== undefined
          )
            await context.commitTerminal(
              "agent.heartbeat",
              previousHeartbeatInformationId,
              heartbeatSupersededInformationKind,
              {
                payload: { replacementInformationId: heartbeat.informationId },
                references: [
                  {
                    relation: "core:status-of",
                    informationId: previousHeartbeatInformationId,
                  },
                ],
              },
            );
        } else
          await oneShot.schedule({
            operationKey: `heartbeat:${heartbeat.informationId}`,
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
          {
            payload: { error: "one-shot scheduling failed" },
            references: [
              {
                relation: "core:status-of",
                informationId: heartbeat.informationId,
              },
            ],
          },
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
          totalWaitBudget: settings.totalWaitBudget,
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
            const previousHeartbeat = open[1] as any;
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
              previousInput?.totalWaitBudget ?? settings.totalWaitBudget,
              previous?.informationId,
              previousHeartbeat?.informationId,
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
              p.sourceInformationIds,
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
            const runtimeContext = candidates.find(
              ({ kind }) => kind === "core.runtime.context",
            );
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
                {
                  payload: { error: "one-shot firing failed" },
                  references: [
                    {
                      relation: "core:status-of",
                      informationId: hb.informationId,
                    },
                  ],
                },
              );
              return;
            }
            if (result.status === "fired") {
              const fired = await context.commitTerminal(
                "agent.heartbeat",
                hb.informationId,
                heartbeatFiredInformationKind,
                {
                  payload: { firedAt: context.now().toISOString() },
                  references: [
                    {
                      relation: "core:status-of",
                      informationId: hb.informationId,
                    },
                  ],
                },
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
                    asOf: p.asOf,
                    policyVersion: p.policyVersion,
                    attempt: p.attempt,
                    totalWaitBudget: p.totalWaitBudget,
                  },
                  references: [
                    {
                      relation: "agent:heartbeat-fired",
                      informationId: fired.informationId,
                    },
                    ...p.sourceInformationIds.map((informationId: string) => ({
                      relation: "core:uses-context" as const,
                      informationId,
                    })),
                  ],
                  ...(runtimeContext === undefined
                    ? {}
                    : { contextInformationId: runtimeContext.informationId }),
                },
              );
            }
          },
        ),
      ],
    };
  },
});
