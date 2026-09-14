/**
 * 功能概述：定义心跳模块的设置、订阅和调度行为。
 * 主要职责：heartbeatSettingsSchema 提供校验及中文公开字段元数据；模块通过调度能力管理等待。
 * 代码库关系：Catalog 与管理表单共用 schema，Host 负责创建实例。
 * 输入输出与副作用：字段声明无副作用；订阅处理写入调度原子，不直接发送消息。
 * heartbeatObservationSelector 只读取开放集合与最近水位；开放期间入站账本即待观察集合。
 * due 用事务 openScope 注册唯一候选；终态 resume 合并期间新输入，只安排一次后续观察。
 * isImmediateObservation 识别私聊、@ 与回复机器人；普通群消息保留首个稀疏观察时刻，避免连续输入饿死。
 */
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
  observationWakeInformationKind,
  turnCompletedInformationKind,
  turnWaitingInformationKind,
  turnSilentInformationKind,
  turnFailedInformationKind,
  turnSupersededInformationKind,
} from "../information-kinds.js";

export const heartbeatSettingsSchema = z
  .object({
    messageDebounceMs: z.number().int().min(0).meta({
      title: "消息防抖时间",
      description: "收集同一会话连续输入的等待时间，单位毫秒。",
      public: true,
      default: 1500,
    }),
    maxReplacementAttempts: z.number().int().min(1).max(20).meta({
      title: "最大替换次数",
      description: "当前轮次允许替换候选的最大次数。",
      public: true,
      default: 3,
    }),
    totalWaitBudget: z.number().int().min(0).max(20).meta({
      title: "等待次数预算",
      description: "每轮允许等待的总次数。",
      public: true,
      default: 3,
    }),
  })
  .strict();
export type HeartbeatSettings = z.infer<typeof heartbeatSettingsSchema>;
export function scopeOf(source: any): string {
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
      openOnly: true,
      scopeKey,
      order: "desc",
      limit: 1,
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

const observationTerminals = [
  turnCompletedInformationKind,
  turnWaitingInformationKind,
  turnSilentInformationKind,
  turnFailedInformationKind,
  turnSupersededInformationKind,
];

/** 高显著信息绕过稀疏节奏；只有平台可验证的私聊、mention、reply 和显式 mention-all 可提升。 */
export function isImmediateObservation(source: any): boolean {
  return (
    source.destination?.kind === "private" ||
    source.destination?.kind === "web" ||
    (source.mentions ?? []).some(
      (mention: any) =>
        mention.kind === "all" ||
        (source.selfId &&
          mention.kind === "user" &&
          mention.id === source.selfId),
    ) ||
    Boolean(source.selfId && source.replyTo?.senderId === source.selfId)
  );
}

/** 查询开放观察与最近候选的水位；普通路径不枚举历史 claims/candidates。 */
export const heartbeatObservationSelector = defineInformationSelector({
  selectorId: "agent.heartbeat.observation",
  select: async ({ sourceAtom, ledger }) => {
    let anchor = sourceAtom;
    if (sourceAtom.kind === oneShotDueInformationKind.kind) {
      const request = (
        await ledger.related({
          from: [sourceAtom.informationId],
          relation: "core:status-of",
          direction: "outgoing",
          limit: 1,
        })
      )[0];
      if (!request) return [];
      anchor = (
        await ledger.related({
          from: [request.informationId],
          relation: "core:caused-by",
          direction: "outgoing",
          limit: 1,
        })
      )[0]!;
      if (!anchor) return [];
    }
    const p = anchor.payload as any;
    const source =
      p.source ??
      (p.platform
        ? {
            platform: p.platform,
            adapterId: p.adapterId,
            destination: p.destination,
          }
        : undefined);
    const scopeKey = p.scopeKey ?? (source ? scopeOf(source) : undefined);
    if (!scopeKey) return [];
    const open = await ledger.find({
      kinds: [turnCandidateInformationKind.kind],
      scopeKey,
      registrationOrder: true,
      openOnly: true,
      order: "desc",
      limit: 1000,
    });
    const latest = await ledger.find({
      kinds: [turnCandidateInformationKind.kind],
      scopeKey,
      registrationOrder: true,
      order: "desc",
      limit: 1,
    });
    const candidate = latest[0];
    const selected = new Map(
      [...open, ...latest].map((a) => [a.informationId, a]),
    );
    if (sourceAtom.kind === waitRequestedInformationKind.kind) {
      for (const a of await ledger.related({
        from: [sourceAtom.informationId],
        relation: "core:caused-by",
        direction: "outgoing",
        limit: 1,
      }))
        selected.set(a.informationId, a);
    }
    // 返回终态以区分唯一开放观察；同 scope 的历史只读取最近一条。
    for (const c of latest)
      for (const a of await ledger.related({
        from: [c.informationId],
        relation: "core:status-of",
        direction: "incoming",
        limit: 10,
      }))
        selected.set(a.informationId, a);
    const target =
      source ??
      (candidate
        ? {
            platform: candidate.payload.platform,
            adapterId: candidate.payload.adapterId,
            destination: candidate.payload.destination,
          }
        : undefined);
    if (target) {
      let watermark = (
        candidate?.payload.sourceInformationIds as string[] | undefined
      )?.at(-1);
      // 恢复合并的来源被冻结在 claim 中；按注册位置取上界，避免回放已爬楼的迟到时间戳输入。
      const terminal = [...selected.values()].find(
        (a) =>
          a.payload.candidateInformationId === candidate?.informationId &&
          observationTerminals.some((k) => k.kind === a.kind),
      );
      if (terminal) {
        const claim = (
          await ledger.related({
            from: [terminal.informationId],
            relation: "agent:turn-claim",
            direction: "outgoing",
            limit: 1,
          })
        )[0];
        const frozen = claim
          ? (
              await ledger.related({
                from: [claim.informationId],
                relation: "agent:turn-claim",
                direction: "incoming",
                limit: 100,
              })
            ).find((a) => a.kind === "agent.turn.context.completed")
          : undefined;
        const ids = frozen
          ? (frozen.payload.inputs as any[]).map((i) => i.informationId)
          : (claim?.references
              .filter((r) => r.relation === "core:uses-context")
              .map((r) => r.informationId) ?? []);
        if (ids.length)
          watermark =
            (
              await ledger.find({
                kinds: [inboundTextInformationKind.kind],
                informationIds: ids,
                registrationOrder: true,
                order: "desc",
                limit: 1,
              })
            )[0]?.informationId ?? watermark;
      }
      const inbounds = await ledger.find({
        kinds: [inboundTextInformationKind.kind],
        ...(watermark ? { afterInformationId: watermark } : {}),
        registrationOrder: true,
        scopeKey,
        payloadContains: {
          source: {
            platform: target.platform,
            adapterId: target.adapterId,
            destination: target.destination,
          },
        },
        order: "desc",
        limit: 1000,
      });
      for (const a of [...inbounds].reverse()) selected.set(a.informationId, a);
    }
    for (const inbound of [...selected.values()].filter(
      (a) => a.kind === inboundTextInformationKind.kind,
    )) {
      const input = (inbound.payload as any).source;
      if (!input?.replyTo?.platformMessageId || isImmediateObservation(input))
        continue;
      const deliveries = await ledger.find({
        kinds: ["core.delivery.delivered"],
        payloadContains: {
          ok: true,
          platform: input.platform,
          adapterId: input.adapterId,
          target: input.destination,
          platformMessageId: input.replyTo.platformMessageId,
        },
        order: "desc",
        limit: 1,
      });
      for (const a of deliveries) selected.set(a.informationId, a);
    }
    return [...selected.keys()];
  },
});

function immediateInState(source: any, state: readonly any[]): boolean {
  return (
    isImmediateObservation(source) ||
    Boolean(
      source.replyTo?.platformMessageId &&
      state.some(
        (a) =>
          a.kind === "core.delivery.delivered" &&
          a.payload.platformMessageId === source.replyTo.platformMessageId,
      ),
    )
  );
}

function openObservations(atoms: readonly any[]) {
  return atoms.filter(
    (a) =>
      a.kind === turnCandidateInformationKind.kind &&
      !atoms.some(
        (t) =>
          observationTerminals.some((k) => k.kind === t.kind) &&
          t.payload.candidateInformationId === a.informationId,
      ),
  );
}

export const heartbeatModule = defineInformationModule({
  manifest: {
    protocolVersion: 1,
    moduleVersion: "1.0.0",
    definitionId: "agent.heartbeat.short",
    displayName: "持久化短心跳",
    summary: "合并入站水位与等待信号，可靠唤醒稀疏观察。",
    description:
      "消费入站消息和等待请求，按防抖、替换及预算策略提交单次调度；到期后竞争唯一开放观察与心跳终态，持久化和触发由 Scheduler 能力负责。",
    settingsSchema: heartbeatSettingsSchema,
    consumes: [
      inboundTextInformationKind,
      waitRequestedInformationKind,
      oneShotDueInformationKind,
      ...observationTerminals,
    ],
    produces: [
      heartbeatScheduledInformationKind,
      heartbeatFiredInformationKind,
      heartbeatSupersededInformationKind,
      heartbeatFailedInformationKind,
      turnCandidateInformationKind,
      observationWakeInformationKind,
    ],
    selectors: [
      heartbeatScopeSelector,
      heartbeatDueSelector,
      heartbeatObservationSelector,
    ],
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
      predecessorCandidateInformationId?: string,
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
            ...(predecessorCandidateInformationId
              ? { predecessorCandidateInformationId }
              : {}),
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
            const observations = await context.select(
              heartbeatObservationSelector,
            );
            const candidate = openObservations(observations)[0];
            if (candidate) {
              const pendingInputs = observations.filter(
                (a) => a.kind === inboundTextInformationKind.kind,
              );
              if (
                !pendingInputs.some(
                  (a) => a.informationId === atom.informationId,
                )
              )
                return;
              const immediate = immediateInState(
                atom.payload.source,
                observations,
              );
              await context.registerOnce(
                "agent.observation.wake",
                `${candidate.informationId}:${immediate ? "immediate" : "normal"}`,
                observationWakeInformationKind,
                {
                  payload: {
                    scopeKey: String(candidate.payload.scopeKey),
                    immediate,
                  },
                  references: [
                    ...pendingInputs.map((a) => ({
                      relation: "core:uses-context",
                      informationId: a.informationId,
                    })),
                    {
                      relation: "agent:turn-candidate",
                      informationId: candidate.informationId,
                    },
                  ],
                },
              );
              return;
            }
            const open = await context.select(heartbeatScopeSelector);
            const previous = open[0] as any;
            const previousHeartbeat = open[1] as any;
            const previousInput = previous?.payload?.input as any;
            const immediate = immediateInState(
              atom.payload.source,
              observations,
            );
            if (previous && !immediate) return;
            const preserveWait =
              !immediate &&
              previousInput?.reason === "wait" &&
              previousInput?.wakeOnMessage === false;
            const dueAt = preserveWait
              ? previous.payload.dueAt
              : new Date(
                  context.now().getTime() +
                    (immediate ? 0 : settings.messageDebounceMs),
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
              previousHeartbeat?.payload?.predecessorCandidateInformationId,
            );
          },
        ),
        onInformation(
          waitRequestedInformationKind,
          { subscriptionId: "heartbeat.wait", delivery: "durable" },
          async (atom, context) => {
            const p = atom.payload as any;
            const state = await context.select(heartbeatObservationSelector);
            const predecessor = state.find(
              (a) => a.kind === "agent.attention.arousal.completed",
            )?.payload.candidateInformationId as string | undefined;
            const latest = state.find(
              (a) => a.kind === turnCandidateInformationKind.kind,
            );
            if (predecessor && latest && latest.informationId !== predecessor)
              return;
            await schedule(
              atom,
              context,
              "wait",
              p.dueAt,
              p.sourceInformationIds,
              p.wakeOnMessage,
              p.attempt,
              p.totalWaitBudget,
              undefined,
              undefined,
              predecessor,
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
              const state = await context.select(heartbeatObservationSelector);
              if (openObservations(state).length) return;
              const p: any = hb.payload;
              if (
                p.predecessorCandidateInformationId &&
                !state.some(
                  (a) =>
                    a.kind === turnCandidateInformationKind.kind &&
                    a.informationId === p.predecessorCandidateInformationId,
                )
              )
                return;
              const observed = new Set(
                state
                  .filter((a) => a.kind === turnCandidateInformationKind.kind)
                  .flatMap((a) => (a.payload as any).sourceInformationIds),
              );
              const pending = state.filter(
                (a) =>
                  a.kind === inboundTextInformationKind.kind &&
                  !observed.has(a.informationId),
              );
              const sourceIds = pending.length
                ? [
                    ...new Set([
                      ...(p.reason === "wait" || p.attempt > 0
                        ? p.sourceInformationIds
                        : []),
                      ...pending.map((a) => a.informationId),
                    ]),
                  ]
                : p.sourceInformationIds;
              if (
                !pending.length &&
                p.reason !== "wait" &&
                state.some((a) => a.kind === turnCandidateInformationKind.kind)
              )
                return;
              const asOf = pending.length
                ? pending.reduce(
                    (latest, a) =>
                      a.occurredAt > latest ? a.occurredAt : latest,
                    p.asOf,
                  )
                : p.asOf;
              await context.registerOnce(
                "agent.turn.candidate",
                hb.informationId,
                turnCandidateInformationKind,
                {
                  openScope: {
                    key: p.scopeKey,
                    terminalGroup: "agent.turn.terminal",
                  },
                  payload: {
                    heartbeatInformationId: hb.informationId,
                    reason: p.reason,
                    dueAt: p.dueAt,
                    firedAt: context.now().toISOString(),
                    platform: p.platform,
                    adapterId: p.adapterId,
                    destination: p.destination,
                    sourceInformationIds: sourceIds,
                    scopeKey: p.scopeKey,
                    asOf,
                    policyVersion: p.policyVersion,
                    attempt: p.attempt,
                    totalWaitBudget: p.totalWaitBudget,
                  },
                  references: [
                    {
                      relation: "agent:heartbeat-fired",
                      informationId: fired.informationId,
                    },
                    ...sourceIds.map((informationId: string) => ({
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
        ...observationTerminals.map((kind) =>
          onInformation(
            kind as import("@kaguya/sdk").InformationKindDefinition<
              string,
              any
            >,
            {
              subscriptionId: `heartbeat.resume.${kind.kind}`,
              delivery: "durable",
            },
            async (atom, context) => {
              const state = await context.select(heartbeatObservationSelector);
              if (openObservations(state).length) return;
              const observed = new Set(
                state
                  .filter((a) => a.kind === turnCandidateInformationKind.kind)
                  .flatMap((a) => (a.payload as any).sourceInformationIds),
              );
              const pending = state.filter(
                (a) =>
                  a.kind === inboundTextInformationKind.kind &&
                  !observed.has(a.informationId),
              );
              const latest = pending.at(-1);
              if (!latest) return;
              const existing = await context.select(heartbeatScopeSelector);
              const previous = existing[0] as any;
              const urgent = pending.some((a) =>
                immediateInState((a.payload as any).source, state),
              );
              if (previous && !urgent) return;
              const previousObservation = state.find(
                (a) => a.kind === turnCandidateInformationKind.kind,
              )!;
              const waiting = state.some(
                (a) =>
                  a.kind === turnWaitingInformationKind.kind &&
                  a.payload.candidateInformationId ===
                    previousObservation.informationId,
              );
              const attempt =
                previous?.payload?.input?.attempt ??
                (waiting ? Number(previousObservation.payload.attempt) + 1 : 0);
              const sources = [
                ...new Set([
                  ...(waiting
                    ? (previousObservation.payload
                        .sourceInformationIds as string[])
                    : []),
                  ...pending.map((a) => a.informationId),
                ]),
              ];
              await schedule(
                {
                  ...atom,
                  payload: { source: (latest.payload as any).source },
                },
                context,
                "message",
                new Date(
                  context.now().getTime() +
                    (urgent ? 0 : settings.messageDebounceMs),
                ).toISOString(),
                sources,
                true,
                attempt,
                Number(previousObservation.payload.totalWaitBudget),
                previous?.informationId,
                existing[1]?.informationId,
                previousObservation.informationId,
              );
            },
          ),
        ),
      ],
    };
  },
});
