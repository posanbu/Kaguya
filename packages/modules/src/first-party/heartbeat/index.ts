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
import { defineInformationModule, onInformation } from "@kaguya/sdk";
import {
  oneShotDueInformationKind,
  oneShotScheduleCapability,
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
  turnWaitingInformationKind,
  turnDecisionInterruptedInformationKind,
  turnInterruptedInformationKind,
} from "../information-kinds.js";

export const heartbeatSettingsSchema = z
  .object({
    messageDebounceMs: z.number().int().min(0).meta({
      title: "消息防抖时间",
      description: "收集同一会话连续输入的等待时间，单位毫秒。",
      public: true,
      default: 1500,
    }),
    plannerInterruptQuietMs: z
      .number()
      .int()
      .min(0)
      .max(60_000)
      .default(1000)
      .meta({
        title: "规划打断后静默窗",
        description: "最后一条新消息后等待多久再重构规划，单位毫秒。",
        public: true,
        default: 1000,
      }),
    maxReplacementAttempts: z.number().int().min(1).max(20).meta({
      title: "最大替换次数",
      description: "当前轮次允许替换候选的最大次数。",
      public: true,
      default: 3,
    }),
    totalWaitBudget: z.number().int().min(0).max(20).meta({
      title: "连续等待上限",
      description: "连续 wait 或注意力延后最多允许多少次。",
      public: true,
      default: 3,
    }),
    noActionBackoffBaseMs: z.number().int().min(0).default(15_000).meta({
      title: "无动作退避基准",
      description: "非 Focus 群聊连续静默后首次退避的毫秒数。",
      public: true,
      default: 15_000,
    }),
    noActionBackoffCapMs: z.number().int().min(0).default(300_000).meta({
      title: "无动作退避上限",
      description: "非 Focus 群聊无动作退避的最长毫秒数。",
      public: true,
      default: 300_000,
    }),
    noActionBackoffStartCount: z.number().int().min(1).default(2).meta({
      title: "无动作退避起点",
      description: "连续多少次静默后开始退避。",
      public: true,
      default: 2,
    }),
    noActionBackoffBypassPendingCount: z.number().int().min(0).default(6).meta({
      title: "退避绕过消息数",
      description: "积累至少多少条新消息时绕过退避；0 表示不按数量绕过。",
      public: true,
      default: 6,
    }),
  })
  .strict();
export type HeartbeatSettings = z.infer<typeof heartbeatSettingsSchema>;
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
      heartbeatIdleBackoffSelector,
    ],
    promptRenderers: [],
    requires: [oneShotScheduleCapability],
    provides: [],
  },
  create: ({ settings }, lifecycle) => {
    const oneShot = lifecycle.use(oneShotScheduleCapability);
    const idleBackoffDueAt = async (
      context: any,
      pendingCount: number,
      immediate: boolean,
      source: any,
    ): Promise<number> => {
      if (source.destination?.kind !== "group" || immediate) return 0;
      if (
        settings.noActionBackoffBaseMs <= 0 ||
        settings.noActionBackoffCapMs <= 0
      )
        return 0;
      if (
        settings.noActionBackoffBypassPendingCount > 0 &&
        pendingCount >= settings.noActionBackoffBypassPendingCount
      )
        return 0;
      const terminals = (await context.select(
        heartbeatIdleBackoffSelector,
      )) as any[];
      const frozen = terminals.find(
        (atom) => atom.kind === "agent.turn.context.completed",
      );
      if (
        frozen?.payload.focusActive &&
        Date.parse(frozen.payload.focusExpiresAt ?? "") >
          context.now().getTime()
      )
        return 0;
      const consecutive = terminals.findIndex(
        (atom) => atom.kind !== "agent.turn.silent",
      );
      const count =
        consecutive < 0
          ? terminals.filter((atom) => atom.kind === "agent.turn.silent").length
          : consecutive;
      if (count < settings.noActionBackoffStartCount) return 0;
      const latest = terminals.find(
        (atom) => atom.kind === "agent.turn.silent",
      );
      if (!latest) return 0;
      const delay = Math.min(
        settings.noActionBackoffCapMs,
        settings.noActionBackoffBaseMs *
          2 ** Math.min(20, count - settings.noActionBackoffStartCount),
      );
      return Date.parse(latest.occurredAt) + delay;
    };
    const schedule = async (
      atom: any,
      context: any,
      reason: "message" | "wait" | "interrupt",
      dueAt: string,
      sourceIds: string[],
      wakeOnMessage: boolean,
      attempt: number,
      totalWaitBudget: number,
      previousScheduleInformationId?: string,
      previousHeartbeatInformationId?: string,
      predecessorCandidateInformationId?: string,
      rebuildAttempt = 0,
    ) => {
      const source = (atom.payload as any).source;
      if (!source) return;
      const scopeKey = scopeOf(source);
      const orderedSourceIds = [...new Set(sourceIds)];
      const asOf = reason === "wait" ? dueAt : atom.occurredAt;
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
            rebuildAttempt,
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
        rebuildAttempt,
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
          plannerInterruptQuietMs: settings.plannerInterruptQuietMs,
          noActionBackoffBaseMs: settings.noActionBackoffBaseMs,
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
            if (previous && !immediate && previousInput?.reason !== "interrupt")
              return;
            const preserveWait =
              !immediate &&
              previousInput?.reason === "wait" &&
              previousInput?.wakeOnMessage === false;
            const dueAt = preserveWait
              ? previous.payload.dueAt
              : new Date(
                  Math.max(
                    context.now().getTime() +
                      (previousInput?.reason === "interrupt"
                        ? settings.plannerInterruptQuietMs
                        : immediate
                          ? 0
                          : settings.messageDebounceMs),
                    await idleBackoffDueAt(
                      context,
                      observations.filter(
                        (a) => a.kind === inboundTextInformationKind.kind,
                      ).length,
                      immediate,
                      (atom.payload as any).source,
                    ),
                  ),
                ).toISOString();
            const reason = preserveWait
              ? "wait"
              : previousInput?.reason === "interrupt"
                ? "interrupt"
                : "message";
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
              previousInput?.rebuildAttempt ?? 0,
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
              const latestCandidate = state.find(
                (a) => a.kind === turnCandidateInformationKind.kind,
              );
              if (
                p.reason !== "interrupt" &&
                latestCandidate &&
                state.some(
                  (a) =>
                    (a.kind === turnInterruptedInformationKind.kind ||
                      a.kind === turnDecisionInterruptedInformationKind.kind) &&
                    a.payload.candidateInformationId ===
                      latestCandidate.informationId,
                )
              )
                return;
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
                      ...(p.reason === "wait" ||
                      p.reason === "interrupt" ||
                      p.attempt > 0
                        ? p.sourceInformationIds
                        : []),
                      ...pending.map((a) => a.informationId),
                    ]),
                  ]
                : p.sourceInformationIds;
              if (
                !pending.length &&
                p.reason !== "wait" &&
                p.reason !== "interrupt" &&
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
                    rebuildAttempt: p.rebuildAttempt ?? 0,
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
              const interrupted = atom.kind === "agent.turn.interrupted";
              if (previous && !urgent && !interrupted) return;
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
                  ...(waiting || interrupted
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
                interrupted ? "interrupt" : "message",
                new Date(
                  Math.max(
                    context.now().getTime() +
                      (interrupted
                        ? settings.plannerInterruptQuietMs
                        : urgent
                          ? 0
                          : settings.messageDebounceMs),
                    await idleBackoffDueAt(
                      context,
                      pending.length,
                      urgent,
                      (latest.payload as any).source,
                    ),
                  ),
                ).toISOString(),
                sources,
                true,
                attempt,
                Number(previousObservation.payload.totalWaitBudget),
                previous?.informationId,
                existing[1]?.informationId,
                previousObservation.informationId,
                interrupted
                  ? Number((atom.payload as any).rebuildAttempt)
                  : Number(
                      (previousObservation.payload as any).rebuildAttempt ?? 0,
                    ),
              );
            },
          ),
        ),
      ],
    };
  },
});

import {
  scopeOf,
  heartbeatScopeSelector,
  heartbeatDueSelector,
  observationTerminals,
  heartbeatObservationSelector,
  heartbeatIdleBackoffSelector,
  immediateInState,
  openObservations,
} from "./observation.js";
export {
  scopeOf,
  heartbeatScopeSelector,
  heartbeatDueSelector,
  isImmediateObservation,
  heartbeatObservationSelector,
} from "./observation.js";
