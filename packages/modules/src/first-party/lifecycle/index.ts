/**
 * 功能概述：统一 Lifecycle 的节拍、活动、睡眠和观察恢复，保留旧持久订阅身份。
 * 主要职责：createLifecycleModule 组合观察及睡眠实例；update 记录活动并管理定时器。
 * lifecycleSettingsSchema 约束时间预算；defer 处理登记持久复查，启动和到期调用 recoverObservations。
 * 代码库关系：Runtime 装配本模块，Scheduler 提供 one-shot，数据库 observationCapability 保存独立快照与进度。
 * 输入输出与副作用：追加 Kind 与调度事实，不调用模型或平台；延期不确认读取，宿主负责重试与关闭。
 */
import {
  recoverySourcesSelector,
  recoverObservations,
} from "./observation-recovery.js";
import { observationCapability, defineInformationSelector } from "@kaguya/sdk";
import {
  observationCompleted,
  observationProgress,
  situationObservationContract,
} from "../observation.js";
import {
  attentionArousalCompletedInformationKind,
  turnCandidateInformationKind,
  observationWakeInformationKind,
} from "../information-kinds.js";
import { z, lifecycleSnapshotSchema } from "@kaguya/schema";
import {
  defineInformationModule,
  onInformation,
  type InformationModuleHandlerContext,
  type InformationModuleSubscription,
} from "@kaguya/sdk";
import { heartbeatModule, heartbeatSettingsSchema } from "./observation.js";
import {
  createAttentionArousalModule,
  attentionArousalSettingsSchema,
  attentionArousalStateSelector,
  attentionArousalTimerSelector,
} from "./sleep.js";
import { firstPartyInspection } from "../inspection.js";

import {
  oneShotScheduleCapability,
  oneShotDueInformationKind,
  oneShotRequestedInformationKind,
} from "@kaguya/scheduler";
import {
  attentionArousalStateRecordedInformationKind,
  inboundTextInformationKind,
} from "../information-kinds.js";
import {
  lifecycleStateInformationKind,
  lifecycleStateSelector,
  advanceActivity,
} from "./activity.js";
import {
  lifecycleStartedInformationKind,
  lifecycleStartupCapability,
  lifecycleTimersSelector,
  lifecycleWorkSelector,
} from "./pulse.js";
import { scopeOf, isImmediateObservation } from "./observation-state.js";

const deferredCandidateSelector = defineInformationSelector({
  selectorId: "agent.lifecycle.deferred-candidate",
  select: async ({ sourceAtom, ledger }) =>
    (
      await ledger.find({
        informationIds: [String(sourceAtom.payload.candidateInformationId)],
        limit: 1,
      })
    ).map((a) => a.informationId),
});
const recoveryScheduleSelector = defineInformationSelector({
  selectorId: "agent.lifecycle.recovery-schedule",
  select: async ({ sourceAtom, ledger }) =>
    (
      await ledger.find({
        informationIds: [String(sourceAtom.payload.scheduleInformationId)],
        limit: 1,
      })
    ).map((a) => a.informationId),
});
export const lifecycleSettingsSchema = z
  .object({
    pulse: z
      .object({
        intervalMs: z.number().int().min(1000).max(3600000).default(5000),
      })
      .strict()
      .default({ intervalMs: 5000 })
      .meta({
        title: "时间节拍",
        public: true,
        description: "清醒时的节拍间隔，单位毫秒。",
      }),
    activity: z
      .object({
        scopeIdleMs: z.number().int().min(1000).max(3600000).default(120000),
      })
      .strict()
      .default({ scopeIdleMs: 120000 })
      .meta({
        title: "当前活动",
        public: true,
        description: "会话最后一次实际活动后的退出期限，单位毫秒。",
      }),
    sleep: attentionArousalSettingsSchema
      .extend({
        idleSleepEnabled: z.boolean().default(true),
        idleSleepAfterMs: z
          .number()
          .int()
          .min(5000)
          .max(86400000)
          .default(600000),
      })
      .default({
        idleSleepEnabled: true,
        idleSleepAfterMs: 600000,
        nightSleepEnabled: false,
        nightSleepStart: "23:00",
        nightSleepEnd: "07:00",
        periodicWakeEnabled: true,
        periodicWakeEveryMs: 300000,
      })
      .meta({
        title: "睡眠与唤醒",
        public: true,
        description: "全局空闲入睡和睡眠复查策略。",
      }),
    observation: heartbeatSettingsSchema
      .default({
        interruptQuietMs: 1000,
        maxReplacementAttempts: 3,
        totalWaitBudget: 3,
        noActionBackoffBaseMs: 15000,
        noActionBackoffCapMs: 300000,
        noActionBackoffStartCount: 2,
        noActionBackoffBypassPendingCount: 6,
      })
      .meta({
        title: "观察调度",
        public: true,
        description: "等待、打断恢复和静默退避参数。",
      }),
  })
  .strict();

export function createLifecycleModule(options: { timeZone: string }) {
  const sleep = createAttentionArousalModule({
    ...options,
    resumeAwakeAfterRecheck: true,
  });
  const observation = heartbeatModule;
  const unique = <
    T extends { id?: string; kind?: string; selectorId?: string },
  >(
    values: readonly T[],
  ) => [
    ...new Map(
      values.map((value) => [
        value.id ?? value.kind ?? value.selectorId,
        value,
      ]),
    ).values(),
  ];
  return defineInformationModule({
    manifest: {
      category: "agent",
      protocolVersion: 1,
      moduleVersion: "3.0.0",
      definitionId: "agent.lifecycle",
      displayName: "Lifecycle 运行生命周期",
      summary: "统一管理当前活动、时间节拍、睡眠唤醒与观察调度。",
      description:
        "清醒时推进活动，空闲时离开会话并入睡。状态更新不直接请求模型。",
      settingsSchema: lifecycleSettingsSchema,
      inspection: {
        ...firstPartyInspection["agent.attention.arousal"]!,
        mechanism: [
          "清醒时每五秒推进活动，相同状态合并。",
          "会话空闲两分钟后离开，全局空闲十分钟后入睡。",
          "睡眠期间每五分钟复查积压，直接呼叫立即唤醒。",
          "观察机会不等于回复，是否参与仍由 Router 判断。",
        ],
        views: [
          {
            id: "activity",
            title: "当前活动与时间线",
            description: "规则状态与合并活动段，独立于模型请求更新。",
            kinds: [lifecycleStateInformationKind.kind],
            fields: [
              { path: "state", label: "睡眠状态" },
              { path: "at", label: "最近推进时间" },
              { path: "lastActivityAt", label: "最近实际活动" },
              { path: "timeline", label: "合并活动段" },
            ],
          },
          ...firstPartyInspection["agent.attention.arousal"]!.views,
          ...firstPartyInspection["agent.heartbeat.short"]!.views,
        ],
      },
      consumes: unique([
        attentionArousalCompletedInformationKind,
        ...sleep.manifest.consumes,
        ...observation.manifest.consumes,
        lifecycleStartedInformationKind,
        attentionArousalStateRecordedInformationKind,
      ]),
      produces: unique([
        observationCompleted,
        observationProgress,
        turnCandidateInformationKind,
        observationWakeInformationKind,
        ...sleep.manifest.produces,
        ...observation.manifest.produces,
        lifecycleStateInformationKind,
        lifecycleStartedInformationKind,
      ]),
      selectors: unique([
        recoverySourcesSelector,
        deferredCandidateSelector,
        recoveryScheduleSelector,
        ...sleep.manifest.selectors!,
        ...observation.manifest.selectors!,
        lifecycleStateSelector,
        lifecycleTimersSelector,
        lifecycleWorkSelector,
      ]),
      requires: unique([
        ...sleep.manifest.requires,
        ...observation.manifest.requires,
        lifecycleStartupCapability,
      ]),
      provides: [],
      promptRenderers: [],
    },
    create: async (config, context) => {
      const sleeping = await sleep.create(
        {
          ...config,
          settings: { ...config.settings.sleep, idleSleepEnabled: false },
        },
        context,
      );
      const observing = await observation.create(
        { ...config, settings: config.settings.observation },
        context,
      );
      const scheduler = context.use(oneShotScheduleCapability);
      const update = async (
        atom: Parameters<InformationModuleSubscription["handle"]>[0],
        ctx: InformationModuleHandlerContext,
      ) => {
        const [states, sleepStates, work] = await Promise.all([
          ctx.select(lifecycleStateSelector),
          ctx.select(attentionArousalStateSelector),
          ctx.select(lifecycleWorkSelector),
        ]);
        const parsed = lifecycleSnapshotSchema.safeParse(states[0]?.payload);
        let previous = parsed.success ? parsed.data : undefined;
        const sleepState = sleepStates.find(
          (a) => a.kind === attentionArousalStateRecordedInformationKind.kind,
        );
        // A new subscription must not replay historical wake transitions as current activity.
        if (
          atom.kind === attentionArousalStateRecordedInformationKind.kind &&
          sleepState?.informationId !== atom.informationId
        )
          return;
        const at = ctx.now().toISOString();
        if (!previous && typeof sleepState?.payload.lastActivityAt === "string")
          previous = {
            state: sleepState.payload.state === "asleep" ? "asleep" : "awake",
            at,
            lastActivityAt: sleepState.payload.lastActivityAt,
            scopeActivityAt: {},
            timeline: [],
          };

        const busy = work.some((a) => a.kind === "core.model.task.requested");
        const completed = work.find((a) =>
          [
            "core.model.task.completed",
            "core.model.task.failed",
            "core.model.task.cancelled",
          ].includes(a.kind),
        );
        if (
          previous &&
          completed &&
          completed.occurredAt > previous.lastActivityAt
        ) {
          previous = structuredClone(previous);
          previous.lastActivityAt = completed.occurredAt;
          const source = work.find(
            (a) => a.informationId === completed.payload.sourceInformationId,
          );
          const target = source?.payload.source ?? source?.payload.target;
          const scope =
            typeof source?.payload.scopeKey === "string"
              ? source.payload.scopeKey
              : target && typeof target === "object" && !Array.isArray(target)
                ? scopeOf(target as Parameters<typeof scopeOf>[0])
                : undefined;
          if (scope) previous.scopeActivityAt[scope] = completed.occurredAt;
        }
        const inbound = atom.kind === inboundTextInformationKind.kind;
        const source = inbound
          ? (atom.payload.source as Parameters<typeof scopeOf>[0])
          : undefined;
        const wake = source && isImmediateObservation(source);
        let state =
          sleepState?.payload.state === "asleep"
            ? ("asleep" as const)
            : ("awake" as const);
        if (wake) state = "awake";
        const observedWake =
          atom.kind === attentionArousalStateRecordedInformationKind.kind &&
          atom.payload.cause === "signal" &&
          atom.payload.state === "awake";

        let next = advanceActivity(previous, {
          at,
          scopeIdleMs: config.settings.activity.scopeIdleMs,
          reason: atom.kind,
          state,
          busy,
          ...(observedWake
            ? { actual: true, scopeKey: String(atom.payload.scopeKey) }
            : {}),
          ...(source && state === "awake"
            ? { scopeKey: scopeOf(source), actual: true }
            : {}),
        });
        if (
          state === "awake" &&
          config.settings.sleep.idleSleepEnabled &&
          !busy &&
          Date.parse(at) - Date.parse(next.lastActivityAt) >=
            config.settings.sleep.idleSleepAfterMs
        ) {
          state = "asleep";
          next = advanceActivity(next, {
            at,
            scopeIdleMs: config.settings.activity.scopeIdleMs,
            reason: "global-idle-sleep",
            state,
          });
        }
        const recorded = await ctx.registerOnce(
          "agent.lifecycle.state",
          atom.informationId,
          lifecycleStateInformationKind,
          { payload: next },
        );
        // Submit the legacy wake-state fact so Router and persisted observation contracts remain valid.
        if (state !== (sleepState?.payload.state ?? "awake")) {
          await ctx.registerOnce(
            "agent.lifecycle.sleep",
            atom.informationId,
            attentionArousalStateRecordedInformationKind,
            {
              payload: {
                state,
                cause: "external",
                lastEvaluatedAt: at,
                lastInboundInformationId: inbound
                  ? atom.informationId
                  : typeof sleepState?.payload.lastInboundInformationId ===
                      "string"
                    ? sleepState.payload.lastInboundInformationId
                    : null,
                lastActivityAt: next.lastActivityAt,
                sleepStartedAt: state === "asleep" ? at : null,
                lastPeriodicWakeAt:
                  typeof sleepState?.payload.lastPeriodicWakeAt === "string"
                    ? sleepState.payload.lastPeriodicWakeAt
                    : null,
                reasonCodes: [
                  state === "asleep" ? "global-idle-sleep" : "direct-wake",
                ],
                policyVersion: "attention-observation.v1",
              },
            },
          );
        }
        if (state === "asleep") {
          const timers = await ctx.select(attentionArousalTimerSelector);
          if (
            config.settings.sleep.periodicWakeEnabled &&
            !timers.some(
              (a) =>
                a.kind === oneShotRequestedInformationKind.kind &&
                (a.payload.input as any)?.purpose === "periodic-wake",
            )
          )
            await scheduler.schedule({
              operationKey: `lifecycle:recheck:${recorded.informationId}`,
              sourceInformationId: recorded.informationId,
              dueAt: new Date(
                Date.parse(at) + config.settings.sleep.periodicWakeEveryMs,
              ).toISOString(),
              input: { purpose: "periodic-wake" },
              activation: config.activation,
            });
          return;
        }
        const timers = await ctx.select(lifecycleTimersSelector);
        if (
          !timers.some(
            (a) => a.informationId !== atom.payload.scheduleInformationId,
          )
        )
          await scheduler.schedule({
            operationKey: `lifecycle:pulse:${recorded.informationId}`,
            sourceInformationId: recorded.informationId,
            dueAt: new Date(
              Date.parse(at) + config.settings.pulse.intervalMs,
            ).toISOString(),
            input: { purpose: "lifecycle-pulse" },
            activation: config.activation,
          });
      };
      const inherited = (instance: typeof sleeping, oldId: string) =>
        instance.subscriptions.map(
          (subscription) =>
            ({
              ...subscription,
              durableSubscriptionId: `${oldId}:${subscription.subscriptionId}`,
              handle: async (atom, ctx) => {
                if (subscription.kind === inboundTextInformationKind.kind)
                  await update(atom, ctx);
                await subscription.handle(atom, ctx);
              },
            }) satisfies InformationModuleSubscription,
        );
      const subscriptions: InformationModuleSubscription[] = [
        onInformation(
          attentionArousalCompletedInformationKind,
          {
            subscriptionId: "lifecycle.observation-defer",
            delivery: "durable",
          },
          async (atom, ctx) => {
            if (atom.payload.outcome !== "defer") return;
            const candidate = (await ctx.select(deferredCandidateSelector))[0];
            if (!candidate) throw new Error("Deferred candidate missing");
            const p = candidate.payload as any;
            const dueAt = new Date(
              ctx.now().getTime() + config.settings.sleep.periodicWakeEveryMs,
            ).toISOString();
            const scheduled = await scheduler.schedule({
              operationKey: `observation-defer:${atom.informationId}`,
              sourceInformationId: atom.informationId,
              dueAt,
              input: { purpose: "observation-recheck", scopeKey: p.scopeKey },
              activation: config.activation,
            });
            const access = ctx.use(observationCapability);
            const contract = situationObservationContract({
              platform: p.platform,
              adapterId: p.adapterId,
              destination: p.destination,
            });
            for (const page of await access.pending(contract))
              await access.defer(
                page.observationId,
                dueAt,
                scheduled.scheduleInformationId,
              );
          },
        ),
        onInformation(
          oneShotDueInformationKind,
          {
            subscriptionId: "lifecycle.observation-recheck",
            delivery: "durable",
          },
          async (atom, ctx) => {
            const schedule = (await ctx.select(recoveryScheduleSelector))[0];
            if (
              (schedule?.payload.input as any)?.purpose !==
              "observation-recheck"
            )
              return;
            await scheduler.finish({
              scheduleInformationId: String(atom.payload.scheduleInformationId),
              status: "fired",
            });
            await recoverObservations(
              ctx,
              config.settings.observation.totalWaitBudget,
            );
          },
        ),
        ...inherited(sleeping, "attention-arousal.default"),
        ...inherited(observing, "heartbeat.default"),
        onInformation(
          lifecycleStartedInformationKind,
          { subscriptionId: "lifecycle.start", delivery: "durable" },
          async (atom, ctx) => {
            if (atom.payload.instanceId === ctx.instanceId) {
              await update(atom, ctx);
              await recoverObservations(
                ctx,
                config.settings.observation.totalWaitBudget,
              );
            }
          },
        ),
        onInformation(
          attentionArousalStateRecordedInformationKind,
          { subscriptionId: "lifecycle.sleep-state", delivery: "durable" },
          update,
        ),
        onInformation(
          oneShotDueInformationKind,
          { subscriptionId: "lifecycle.pulse", delivery: "durable" },
          async (atom, ctx) => {
            const timers = await ctx.select(lifecycleTimersSelector);
            if (
              !timers.some(
                (a) => a.informationId === atom.payload.scheduleInformationId,
              )
            )
              return;
            const result = await scheduler.finish({
              scheduleInformationId: atom.payload.scheduleInformationId,
              status: "fired",
            });
            if (result.status === "fired") await update(atom, ctx);
          },
        ),
      ];
      // Serialize all internal transitions against the same durable state.
      let tail = Promise.resolve();
      return {
        provisions: [],
        ready: async () =>
          context
            .use(lifecycleStartupCapability)
            .start(config.activation.instanceId),
        subscriptions: subscriptions.map((subscription) => ({
          ...subscription,
          handle: (atom, ctx) => {
            const run = tail.then(() => subscription.handle(atom, ctx));
            tail = run.then(
              () => undefined,
              () => undefined,
            );
            return run;
          },
        })),
        describeStartup: () => ({
          summary: "Lifecycle ready",
          fields: {
            pulseIntervalMs: config.settings.pulse.intervalMs,
            scopeIdleMs: config.settings.activity.scopeIdleMs,
          },
        }),
      };
    },
  });
}
