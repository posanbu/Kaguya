/**
 * 功能概述：定义心跳模块的设置、订阅和调度行为。
 * 主要职责：heartbeatSettingsSchema 提供校验及中文公开字段元数据；模块通过调度能力管理等待。
 * 代码库关系：Catalog 与管理表单共用 schema，Host 负责创建实例。
 * 输入输出与副作用：字段声明无副作用；订阅处理写入调度原子，不直接发送消息。
 * heartbeatObservationSelector 只读取开放集合与最近水位；开放期间入站账本即待观察集合。
 * 入站按 scope 直接竞争唯一候选；due 仅恢复 Planner wait/interrupt，终态 resume 合并期间新输入。
 * isImmediateObservation 识别私聊、@ 与回复机器人，用于唤醒休眠状态和提升已有观察。
 * inspection 声明本模块的只读机制、领域数据和历史视图，由 Host/Server 投影给开发者控制台。
 */
import { firstPartyInspection } from "../inspection.js";
import { z } from "@kaguya/schema";
import { defineInformationModule, onInformation } from "@kaguya/sdk";
import {
  oneShotDueInformationKind,
  oneShotScheduleCapability,
} from "@kaguya/scheduler";
import {
  attentionArousalActivityInformationKind,
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
  attentionArousalStateRecordedInformationKind,
} from "../information-kinds.js";

export const heartbeatSettingsSchema = z
  .object({
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
      description: "Planner 连续 wait 最多允许多少次。",
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
    moduleVersion: "2.0.0",
    definitionId: "agent.heartbeat.short",
    inspection: firstPartyInspection["agent.heartbeat.short"],
    displayName: "持久化观察调度",
    summary: "按会话积攒通知，并为 awake 状态直接产生观察机会。",
    description:
      "入站消息直接竞争同一会话的唯一开放观察；未观察内容继续按水位积攒，Planner wait 与 interrupt 才使用持久化单次调度。",
    settingsSchema: heartbeatSettingsSchema,
    consumes: [
      attentionArousalStateRecordedInformationKind,
      inboundTextInformationKind,
      waitRequestedInformationKind,
      oneShotDueInformationKind,
      ...observationTerminals,
    ],
    produces: [
      attentionArousalActivityInformationKind,
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
      heartbeatDeferredObservationSelector,
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
      reason: "message" | "wait" | "interrupt" | "recheck",
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
        summary: "Scope notification observation ready",
        fields: {
          plannerInterruptQuietMs: settings.plannerInterruptQuietMs,
          noActionBackoffBaseMs: settings.noActionBackoffBaseMs,
          maxReplacementAttempts: settings.maxReplacementAttempts,
          totalWaitBudget: settings.totalWaitBudget,
          policyVersion: "short-heartbeat.v1",
        },
      }),
      subscriptions: [
        onInformation(
          attentionArousalStateRecordedInformationKind,
          { subscriptionId: "heartbeat.arousal-wake", delivery: "durable" },
          async (atom, context) => {
            const reasons = atom.payload.reasonCodes as readonly string[];
            if (!reasons.includes("periodic-wake")) return;
            const selected = await context.select(
              heartbeatDeferredObservationSelector,
            );
            const candidates = selected.filter(
              (item) => item.kind === turnCandidateInformationKind.kind,
            );
            for (const previousCandidate of candidates) {
              const p = previousCandidate.payload as any;
              const pending = selected.filter(
                (item) =>
                  item.kind === inboundTextInformationKind.kind &&
                  scopeOf((item.payload as any).source) === p.scopeKey,
              );
              const latest = pending.at(-1);
              if (!latest) continue;
              const runtimeContext = selected.find(
                (item) =>
                  item.kind === "core.runtime.context" &&
                  previousCandidate.references.some(
                    (reference) =>
                      reference.relation === "core:context" &&
                      reference.informationId === item.informationId,
                  ),
              );
              if (!runtimeContext) continue;
              const observed = selected.find(
                (item) =>
                  item.kind === "agent.turn.context.completed" &&
                  item.payload.scopeKey === previousCandidate.payload.scopeKey,
              );
              const signals = [
                ...new Set([
                  ...pending.flatMap((inbound) =>
                    observationSignals(
                      (inbound.payload as any).source,
                      selected,
                    ),
                  ),
                  "recheck",
                ]),
              ];
              await context.registerOnce(
                "agent.turn.candidate",
                `${atom.informationId}:${String(p.scopeKey)}`,
                turnCandidateInformationKind,
                {
                  openScope: {
                    key: String(p.scopeKey),
                    terminalGroup: "agent.turn.terminal",
                  },
                  payload: {
                    triggerInformationId: atom.informationId,
                    reason: "recheck" as const,
                    dueAt: atom.occurredAt,
                    firedAt: atom.occurredAt,
                    platform: p.platform,
                    adapterId: p.adapterId,
                    destination: p.destination,
                    ...(observed?.payload.observedThroughInformationId
                      ? {
                          unreadAfterInformationId: String(
                            observed.payload.observedThroughInformationId,
                          ),
                        }
                      : {}),
                    unreadThroughInformationId: latest.informationId,
                    unreadCount: pending.length,
                    signals,
                    scopeKey: p.scopeKey,
                    asOf: latest.occurredAt,
                    policyVersion: "attention-opportunity.v1" as const,
                    rebuildAttempt: Number(p.rebuildAttempt ?? 0),
                    attempt: Number(p.attempt ?? 0),
                    totalWaitBudget: Number(
                      p.totalWaitBudget ?? settings.totalWaitBudget,
                    ),
                  },
                  references: [],
                  contextInformationId: runtimeContext.informationId,
                },
              );
            }
          },
        ),
        onInformation(
          inboundTextInformationKind,
          { subscriptionId: "heartbeat.message", delivery: "durable" },
          async (atom, context) => {
            await context.registerOnce(
              "agent.attention.arousal.activity",
              atom.informationId,
              attentionArousalActivityInformationKind,
              {
                payload: {
                  inboundInformationId: atom.informationId,
                  observedAt: context.now().toISOString(),
                  policyVersion: "attention-activity.v1" as const,
                },
                references: [],
              },
            );
            const observations = await context.select(
              heartbeatObservationSelector,
            );
            const candidate = openObservations(observations)[0];
            if (candidate) {
              const pendingInputs = observations.filter(
                (item) => item.kind === inboundTextInformationKind.kind,
              );
              if (
                !pendingInputs.some(
                  (item) => item.informationId === atom.informationId,
                )
              )
                return;
              const immediate = immediateInState(
                atom.payload.source,
                observations,
              );
              await context.registerOnce(
                "agent.observation.wake",
                `${candidate.informationId}:${atom.informationId}`,
                observationWakeInformationKind,
                {
                  payload: {
                    scopeKey: String(candidate.payload.scopeKey),
                    immediate,
                  },
                  references: [
                    ...pendingInputs.map((item) => ({
                      relation: "core:uses-context" as const,
                      informationId: item.informationId,
                    })),
                    {
                      relation: "agent:turn-candidate" as const,
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
            const latestObservation = observations.find(
              (item) => item.kind === turnCandidateInformationKind.kind,
            );
            const interruptionPendingSchedule =
              !previous &&
              latestObservation !== undefined &&
              observations.some(
                (item) =>
                  (item.kind === turnInterruptedInformationKind.kind ||
                    item.kind ===
                      turnDecisionInterruptedInformationKind.kind) &&
                  item.payload.candidateInformationId ===
                    latestObservation.informationId,
              );
            if (interruptionPendingSchedule) return;
            if (!previous) {
              const pendingInputs = observations.filter(
                (item) => item.kind === inboundTextInformationKind.kind,
              );
              const latest = pendingInputs.at(-1);
              if (!latest) return;
              const observedContext = observations.find(
                (item) => item.kind === "agent.turn.context.completed",
              );
              const signals = [
                ...new Set(
                  pendingInputs.flatMap((input) =>
                    observationSignals(
                      (input.payload as any).source,
                      observations,
                    ),
                  ),
                ),
              ];
              const now = context.now().toISOString();
              await context.registerOnce(
                "agent.turn.candidate",
                atom.informationId,
                turnCandidateInformationKind,
                {
                  openScope: {
                    key: scopeOf(atom.payload.source),
                    terminalGroup: "agent.turn.terminal",
                  },
                  payload: {
                    triggerInformationId: atom.informationId,
                    reason: "message" as const,
                    dueAt: now,
                    firedAt: now,
                    platform: atom.payload.source.platform,
                    adapterId: atom.payload.source.adapterId,
                    destination: atom.payload.source.destination,
                    ...(observedContext?.payload
                      .observedThroughInformationId === undefined
                      ? {}
                      : {
                          unreadAfterInformationId: String(
                            observedContext.payload
                              .observedThroughInformationId,
                          ),
                        }),
                    unreadThroughInformationId: latest.informationId,
                    unreadCount: pendingInputs.length,
                    signals,
                    scopeKey: scopeOf(atom.payload.source),
                    asOf: latest.occurredAt,
                    policyVersion: "attention-opportunity.v1" as const,
                    rebuildAttempt: 0,
                    attempt: 0,
                    totalWaitBudget: settings.totalWaitBudget,
                  },
                  references: [],
                },
              );
              return;
            }
            const preserveWait =
              !immediate &&
              previousInput?.reason === "wait" &&
              previousInput?.wakeOnMessage === false;
            const preserveRecheck =
              !immediate && previousInput?.reason === "recheck";
            if (previous && (preserveWait || preserveRecheck)) return;
            const dueAt = new Date(
              context.now().getTime() +
                (previousInput?.reason === "interrupt"
                  ? settings.plannerInterruptQuietMs
                  : 0),
            ).toISOString();
            const reason =
              previousInput?.reason === "interrupt" ? "interrupt" : "message";
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
              true,
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
              await context.commitTerminal(
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
              const pending = state.filter(
                (a) => a.kind === inboundTextInformationKind.kind,
              );
              const replayCandidate = state.find(
                (a) =>
                  a.kind === turnCandidateInformationKind.kind &&
                  a.informationId === p.predecessorCandidateInformationId,
              );
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
              const upperInformationId =
                pending.at(-1)?.informationId ??
                (replayCandidate?.payload.unreadThroughInformationId as
                  string | undefined);
              if (!upperInformationId) return;
              const observedContext = state.find(
                (a) => a.kind === "agent.turn.context.completed",
              );
              const unreadAfterInformationId = replayCandidate
                ? (replayCandidate.payload.unreadAfterInformationId as
                    string | undefined)
                : (observedContext?.payload.observedThroughInformationId as
                    string | undefined);
              const signals = [
                ...new Set([
                  ...pending.flatMap((a) =>
                    observationSignals((a.payload as any).source, state),
                  ),
                  ...(p.reason === "recheck" || p.reason === "wait"
                    ? ["recheck"]
                    : []),
                ]),
              ];
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
                    triggerInformationId: atom.informationId,
                    reason: p.reason,
                    dueAt: p.dueAt,
                    firedAt: context.now().toISOString(),
                    platform: p.platform,
                    adapterId: p.adapterId,
                    destination: p.destination,
                    ...(unreadAfterInformationId
                      ? {
                          unreadAfterInformationId,
                        }
                      : {}),
                    unreadThroughInformationId: upperInformationId,
                    unreadCount:
                      Number(replayCandidate?.payload.unreadCount ?? 0) +
                      pending.length,
                    signals,
                    scopeKey: p.scopeKey,
                    asOf,
                    policyVersion: "attention-opportunity.v1" as const,
                    rebuildAttempt: p.rebuildAttempt ?? 0,
                    attempt: p.attempt,
                    totalWaitBudget: p.totalWaitBudget,
                  },
                  references: [],
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
              const deferred =
                atom.kind === "agent.attention.arousal.completed" &&
                (atom.payload as any).outcome === "defer";
              const state = await context.select(heartbeatObservationSelector);
              if (openObservations(state).length) return;
              const pending = state.filter(
                (item) => item.kind === inboundTextInformationKind.kind,
              );
              const latest = pending.at(-1);
              if (!latest) return;
              const existing = await context.select(heartbeatScopeSelector);
              const previous = existing[0] as any;
              const urgent = pending.some((item) =>
                immediateInState((item.payload as any).source, state),
              );
              if (deferred && !urgent) return;
              const interrupted = atom.kind === "agent.turn.interrupted";
              if (previous && !urgent && !interrupted) return;
              const previousObservation = state.find(
                (item) => item.kind === turnCandidateInformationKind.kind,
              );
              if (!previousObservation) return;
              const waiting = state.some(
                (item) =>
                  item.kind === turnWaitingInformationKind.kind &&
                  item.payload.candidateInformationId ===
                    previousObservation.informationId,
              );
              const attempt =
                previous?.payload?.input?.attempt ??
                (waiting ? Number(previousObservation.payload.attempt) + 1 : 0);
              if (!previous && !interrupted) {
                const observedContext = state.find(
                  (item) => item.kind === "agent.turn.context.completed",
                );
                const signals = [
                  ...new Set(
                    pending.flatMap((input) =>
                      observationSignals((input.payload as any).source, state),
                    ),
                  ),
                ];
                const now = context.now().toISOString();
                await context.registerOnce(
                  "agent.turn.candidate",
                  atom.informationId,
                  turnCandidateInformationKind,
                  {
                    openScope: {
                      key: scopeOf((latest.payload as any).source),
                      terminalGroup: "agent.turn.terminal",
                    },
                    payload: {
                      triggerInformationId: atom.informationId,
                      reason: "message" as const,
                      dueAt: now,
                      firedAt: now,
                      platform: (latest.payload as any).source.platform,
                      adapterId: (latest.payload as any).source.adapterId,
                      destination: (latest.payload as any).source.destination,
                      ...(observedContext?.payload
                        .observedThroughInformationId === undefined
                        ? {}
                        : {
                            unreadAfterInformationId: String(
                              observedContext.payload
                                .observedThroughInformationId,
                            ),
                          }),
                      unreadThroughInformationId: latest.informationId,
                      unreadCount: pending.length,
                      signals,
                      scopeKey: scopeOf((latest.payload as any).source),
                      asOf: latest.occurredAt,
                      policyVersion: "attention-opportunity.v1" as const,
                      rebuildAttempt: Number(
                        (previousObservation.payload as any).rebuildAttempt ??
                          0,
                      ),
                      attempt,
                      totalWaitBudget: Number(
                        previousObservation.payload.totalWaitBudget,
                      ),
                    },
                    references: [],
                  },
                );
                return;
              }
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
                          : 0),
                    await idleBackoffDueAt(
                      context,
                      pending.length,
                      urgent,
                      (latest.payload as any).source,
                    ),
                  ),
                ).toISOString(),
                pending.map((item) => item.informationId),
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
  heartbeatDeferredObservationSelector,
  immediateInState,
  observationSignals,
  openObservations,
} from "./observation.js";
export {
  scopeOf,
  heartbeatScopeSelector,
  heartbeatDueSelector,
  isImmediateObservation,
  heartbeatObservationSelector,
} from "./observation.js";
