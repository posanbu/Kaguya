/**
 * Arousal 是正文读取之前的非语义唤醒状态机与注意力观察器。
 * 它只消费 Heartbeat 冻结的观察机会、最新唤醒状态与 Focus 租约事实；不得选择入站正文。
 * 默认状态为 awake；既有直接观察信号会确认 awake，awake 状态下普通机会也默认 observe。
 */
import { firstPartyInspection } from "../inspection.js";
import { z, type DeepReadonly, type InformationAtom } from "@kaguya/schema";
import {
  defineInformationModule,
  defineInformationSelector,
  onInformation,
} from "@kaguya/sdk";
import {
  oneShotDueInformationKind,
  oneShotRequestedInformationKind,
  oneShotScheduleCapability,
} from "@kaguya/scheduler";

import {
  attentionArousalActivityInformationKind,
  attentionArousalCompletedInformationKind,
  attentionArousalStateRecordedInformationKind,
  type AttentionArousalState,
  turnCandidateInformationKind,
} from "../information-kinds.js";
import { activeFocus } from "../attention-focus/facts.js";
import { focusStateSelector } from "../attention-focus/index.js";

export const attentionArousalSettingsSchema = z
  .object({
    idleSleepEnabled: z.boolean().default(false).meta({
      title: "全局无消息休眠",
      description: "开启后，全局连续无消息达到指定时长时进入休眠。",
      public: true,
      default: false,
    }),
    idleSleepAfterMs: z
      .number()
      .int()
      .min(5_000)
      .max(86_400_000)
      .default(120_000)
      .meta({
        title: "无消息休眠时间",
        description: "连续无全局消息多久后休眠，单位毫秒；默认两分钟。",
        public: true,
        default: 120_000,
      }),
    nightSleepEnabled: z.boolean().default(false).meta({
      title: "夜间休眠",
      description: "开启后，在配置的本地开始时间到达时进入休眠。",
      public: true,
      default: false,
    }),
    nightSleepStart: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default("23:00")
      .meta({
        title: "夜间开始时间",
        description: "本地时区的 24 小时时间，格式 HH:mm；默认 23:00。",
        public: true,
        default: "23:00",
      }),
    nightSleepEnd: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default("07:00")
      .meta({
        title: "夜间结束时间",
        description: "本地时区的 24 小时时间，格式 HH:mm；默认 07:00。",
        public: true,
        default: "07:00",
      }),
    periodicWakeEnabled: z.boolean().default(true).meta({
      title: "休眠周期唤醒",
      description: "开启后，休眠状态会按指定时长短暂唤醒一次。",
      public: true,
      default: true,
    }),
    periodicWakeEveryMs: z
      .number()
      .int()
      .min(5_000)
      .max(86_400_000)
      .default(300_000)
      .meta({
        title: "周期唤醒时间",
        description: "休眠后每隔多久唤醒一次，单位毫秒；默认五分钟。",
        public: true,
        default: 300_000,
      }),
  })
  .strict();
export type AttentionArousalSettings = z.infer<
  typeof attentionArousalSettingsSchema
>;
export type AttentionArousalOutcome = "observe" | "defer";

export interface AttentionObservationInput {
  readonly signals: readonly string[];
  readonly focusActive: boolean;
  readonly arousalState?: AttentionArousalState;
}

const DIRECT_SIGNALS = new Set([
  "private",
  "web",
  "mention-self",
  "mention-all",
  "reply-self",
]);

export function decideAttentionArousal(input: AttentionObservationInput): {
  outcome: AttentionArousalOutcome;
  reasonCodes: string[];
  arousalState: AttentionArousalState;
  wakeSignal: boolean;
} {
  const direct = input.signals.filter((signal) => DIRECT_SIGNALS.has(signal));
  if (direct.length > 0)
    return {
      outcome: "observe",
      reasonCodes: direct,
      arousalState: "awake",
      wakeSignal: true,
    };
  if (input.focusActive)
    return {
      outcome: "observe",
      reasonCodes: ["focus-active"],
      arousalState: "awake",
      wakeSignal: true,
    };
  if (input.signals.includes("recheck"))
    return {
      outcome: "observe",
      reasonCodes: ["periodic-recheck"],
      arousalState: "awake",
      wakeSignal: true,
    };
  if ((input.arousalState ?? "awake") === "awake")
    return {
      outcome: "observe",
      reasonCodes: ["arousal-awake"],
      arousalState: "awake",
      wakeSignal: false,
    };
  return {
    outcome: "defer",
    reasonCodes: ["arousal-asleep"],
    arousalState: "asleep",
    wakeSignal: false,
  };
}

export function localTimeOfDay(scheduledAt: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(scheduledAt));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("hour")}:${value("minute")}`;
}

export function isNightSleepTime(
  localTime: string,
  settings: AttentionArousalSettings,
): boolean {
  if (!settings.nightSleepEnabled) return false;
  return settings.nightSleepStart < settings.nightSleepEnd
    ? localTime >= settings.nightSleepStart &&
        localTime < settings.nightSleepEnd
    : localTime >= settings.nightSleepStart ||
        localTime < settings.nightSleepEnd;
}

export function nextLocalTimeOccurrence(
  now: string,
  target: string,
  timeZone: string,
): string {
  const start = Math.floor(Date.parse(now) / 60_000) * 60_000 + 60_000;
  for (let minute = 0; minute < 3 * 24 * 60; minute += 1) {
    const candidate = new Date(start + minute * 60_000).toISOString();
    if (localTimeOfDay(candidate, timeZone) === target) return candidate;
  }
  throw new Error(`Unable to resolve local time ${target} in ${timeZone}`);
}

export const attentionArousalStateSelector = defineInformationSelector({
  selectorId: "agent.attention.arousal.state",
  select: async ({ ledger }) => {
    const [states, activities] = await Promise.all([
      ledger.find({
        kinds: [attentionArousalStateRecordedInformationKind.kind],
        registrationOrder: true,
        order: "desc",
        limit: 1,
      }),
      ledger.find({
        kinds: [attentionArousalActivityInformationKind.kind],
        registrationOrder: true,
        order: "desc",
        limit: 1,
      }),
    ]);
    return [...states, ...activities].map((atom) => atom.informationId);
  },
});

export const attentionArousalTimerSelector = defineInformationSelector({
  selectorId: "agent.attention.arousal.timers",
  select: async ({ sourceAtom, ledger }) => {
    const selected = new Map<string, DeepReadonly<InformationAtom>>();
    if (sourceAtom.kind === oneShotDueInformationKind.kind) {
      for (const request of await ledger.related({
        from: [sourceAtom.informationId],
        relation: "core:status-of",
        direction: "outgoing",
        limit: 1,
      })) {
        selected.set(request.informationId, request);
        for (const source of await ledger.related({
          from: [request.informationId],
          relation: "core:caused-by",
          direction: "outgoing",
          limit: 1,
        }))
          selected.set(source.informationId, source);
      }
    } else {
      for (const request of await ledger.find({
        kinds: [oneShotRequestedInformationKind.kind],
        openOnly: true,
        registrationOrder: true,
        order: "desc",
        limit: 100,
      })) {
        if (
          (request.payload as any).activation?.definitionId ===
          "agent.attention.arousal"
        )
          selected.set(request.informationId, request);
      }
    }
    const latestState = (
      await ledger.find({
        kinds: [attentionArousalStateRecordedInformationKind.kind],
        registrationOrder: true,
        order: "desc",
        limit: 1,
      })
    )[0];
    if (latestState) selected.set(latestState.informationId, latestState);
    const latestActivity = (
      await ledger.find({
        kinds: [attentionArousalActivityInformationKind.kind],
        registrationOrder: true,
        order: "desc",
        limit: 1,
      })
    )[0];
    if (latestActivity)
      selected.set(latestActivity.informationId, latestActivity);
    return [...selected.keys()];
  },
});

export interface CreateAttentionArousalModuleOptions {
  readonly timeZone: string;
}

export function createAttentionArousalModule(
  options: CreateAttentionArousalModuleOptions,
) {
  return defineInformationModule({
    manifest: {
      protocolVersion: 1,
      moduleVersion: "2.0.0",
      definitionId: "agent.attention.arousal",
      inspection: firstPartyInspection["agent.attention.arousal"],
      displayName: "注意力观察",
      summary: "维护机器人唤醒状态，并在读取正文前决定观察或延后。",
      description:
        "初始保持 awake；全局空闲、夜间休眠和周期唤醒使用持久化 one-shot 直接等待绝对时间，不轮询也不累计 tick。通知、Focus 与周期复查会确认唤醒；相关性、话题和参与价值仍由 Planner 独占。",
      settingsSchema: attentionArousalSettingsSchema,
      consumes: [
        turnCandidateInformationKind,
        attentionArousalActivityInformationKind,
        oneShotDueInformationKind,
      ],
      produces: [
        attentionArousalStateRecordedInformationKind,
        attentionArousalCompletedInformationKind,
      ],
      selectors: [
        focusStateSelector,
        attentionArousalStateSelector,
        attentionArousalTimerSelector,
      ],
      promptRenderers: [],
      requires: [oneShotScheduleCapability],
      provides: [],
    },
    create: ({ settings, activation }, lifecycle) => {
      const scheduler = lifecycle.use(oneShotScheduleCapability);
      type TimerPurpose = "idle-sleep" | "periodic-wake" | "night-boundary";
      const armTimer = async (
        source: DeepReadonly<InformationAtom>,
        context: any,
        purpose: TimerPurpose,
        dueAt: string,
        details: Record<string, string> = {},
        preserveExisting = false,
      ) => {
        const timers = (await context.select(
          attentionArousalTimerSelector,
        )) as readonly DeepReadonly<InformationAtom>[];
        const previous = timers.find(
          (atom) =>
            atom.kind === oneShotRequestedInformationKind.kind &&
            (atom.payload as any).activation?.instanceId ===
              context.instanceId &&
            (atom.payload as any).input?.purpose === purpose,
        );
        const request = {
          operationKey: `arousal:${purpose}:${source.informationId}`,
          sourceInformationId: source.informationId,
          dueAt,
          input: { purpose, ...details },
          activation,
        };
        if (previous && preserveExisting) return;
        if (
          previous &&
          (previous.payload as any).operationKey === request.operationKey &&
          (previous.payload as any).dueAt === dueAt
        )
          return;
        if (previous)
          await scheduler.replace({
            ...request,
            previousScheduleInformationId: previous.informationId,
          });
        else await scheduler.schedule(request);
      };
      const armNightBoundary = async (
        source: DeepReadonly<InformationAtom>,
        context: any,
        now: string,
      ) => {
        if (!settings.nightSleepEnabled) return;
        const night = isNightSleepTime(
          localTimeOfDay(now, options.timeZone),
          settings,
        );
        const boundary = night ? "end" : "start";
        const target = night
          ? settings.nightSleepEnd
          : settings.nightSleepStart;
        await armTimer(
          source,
          context,
          "night-boundary",
          nextLocalTimeOccurrence(now, target, options.timeZone),
          { boundary },
        );
      };
      const armPeriodicWake = async (
        source: DeepReadonly<InformationAtom>,
        context: any,
        now: string,
      ) => {
        if (!settings.periodicWakeEnabled) return;
        await armTimer(
          source,
          context,
          "periodic-wake",
          new Date(
            Date.parse(now) + settings.periodicWakeEveryMs,
          ).toISOString(),
          {},
          true,
        );
      };
      return {
        provisions: [],
        describeStartup: () => ({
          summary: "Non-semantic attention observation ready",
          fields: {
            policyVersion: "attention-observation.v1",
            defaultState: "awake",
            timeZone: options.timeZone,
            idleSleepEnabled: settings.idleSleepEnabled,
            idleSleepAfterMs: settings.idleSleepAfterMs,
            nightSleepEnabled: settings.nightSleepEnabled,
            nightSleepStart: settings.nightSleepStart,
            nightSleepEnd: settings.nightSleepEnd,
            periodicWakeEnabled: settings.periodicWakeEnabled,
            periodicWakeEveryMs: settings.periodicWakeEveryMs,
          },
        }),
        subscriptions: [
          onInformation(
            turnCandidateInformationKind,
            {
              subscriptionId: "attention-arousal.observe",
              delivery: "durable",
            },
            async (candidate, context) => {
              const payload = candidate.payload as any;
              const focusAtoms = (await context.select(
                focusStateSelector,
              )) as readonly DeepReadonly<InformationAtom>[];
              const focus = activeFocus(
                focusAtoms,
                String(payload.scopeKey),
                context.now().toISOString(),
              );
              const stateAtoms = (await context.select(
                attentionArousalStateSelector,
              )) as readonly DeepReadonly<InformationAtom>[];
              const previousState = stateAtoms.find(
                (atom) =>
                  atom.kind ===
                  attentionArousalStateRecordedInformationKind.kind,
              );
              const latestActivity = stateAtoms.find(
                (atom) =>
                  atom.kind === attentionArousalActivityInformationKind.kind,
              );
              const now = context.now().toISOString();
              const night = isNightSleepTime(
                localTimeOfDay(now, options.timeZone),
                settings,
              );
              const arousalState = night
                ? ("asleep" as const)
                : ((previousState?.payload.state as
                    AttentionArousalState | undefined) ?? "awake");
              const timeState = {
                lastEvaluatedAt: now,
                lastInboundInformationId:
                  (latestActivity?.payload.inboundInformationId as
                    string | undefined) ??
                  String(payload.unreadThroughInformationId),
                lastActivityAt: String(
                  latestActivity?.payload.observedAt ??
                    previousState?.payload.lastActivityAt ??
                    now,
                ),
                sleepStartedAt:
                  arousalState === "asleep"
                    ? ((previousState?.payload.sleepStartedAt as
                        string | null) ?? now)
                    : null,
                lastPeriodicWakeAt:
                  (previousState?.payload.lastPeriodicWakeAt as
                    string | null) ?? null,
              };
              const decision = decideAttentionArousal({
                signals: payload.signals,
                focusActive: focus !== undefined,
                arousalState,
              });
              let state = previousState;
              if (
                !state ||
                decision.wakeSignal ||
                state.payload.state !== decision.arousalState
              ) {
                state = await context.registerOnce(
                  "agent.attention.arousal.state",
                  candidate.informationId,
                  attentionArousalStateRecordedInformationKind,
                  {
                    payload: {
                      state: decision.arousalState,
                      cause: decision.wakeSignal
                        ? "signal"
                        : night
                          ? "policy"
                          : "default",
                      scopeKey: payload.scopeKey,
                      candidateInformationId: candidate.informationId,
                      ...timeState,
                      sleepStartedAt:
                        decision.arousalState === "asleep"
                          ? timeState.sleepStartedAt
                          : null,
                      reasonCodes: decision.wakeSignal
                        ? decision.reasonCodes
                        : night
                          ? ["night-sleep"]
                          : ["default-awake"],
                      policyVersion: "attention-observation.v1" as const,
                    },
                    references: [],
                  },
                );
              }
              const input = {
                payload: {
                  outcome: decision.outcome,
                  arousalState: decision.arousalState,
                  arousalStateInformationId: state.informationId,
                  wakeSignal: decision.wakeSignal,
                  candidateInformationId: candidate.informationId,
                  scopeKey: payload.scopeKey,
                  ...(payload.unreadAfterInformationId === undefined
                    ? {}
                    : {
                        unreadAfterInformationId:
                          payload.unreadAfterInformationId,
                      }),
                  unreadThroughInformationId:
                    payload.unreadThroughInformationId,
                  unreadCount: payload.unreadCount,
                  signals: payload.signals,
                  focusState: focus
                    ? ("active" as const)
                    : ("inactive" as const),
                  ...(focus
                    ? {
                        focusInformationId: focus.informationId,
                        focusExpiresAt: String(focus.payload.expiresAt),
                      }
                    : {}),
                  reasonCodes: decision.reasonCodes,
                  policyVersion: "attention-observation.v1" as const,
                },
                references: [
                  {
                    relation: "core:status-of" as const,
                    informationId: candidate.informationId,
                  },
                  {
                    relation: "core:uses-context" as const,
                    informationId: state.informationId,
                  },
                  ...(focus
                    ? [
                        {
                          relation: "core:uses-context" as const,
                          informationId: focus.informationId,
                        },
                      ]
                    : []),
                ],
              };
              if (decision.outcome === "defer")
                await context.commitTerminal(
                  "agent.turn.terminal",
                  candidate.informationId,
                  attentionArousalCompletedInformationKind,
                  input,
                );
              else
                await context.registerOnce(
                  "agent.attention.arousal",
                  candidate.informationId,
                  attentionArousalCompletedInformationKind,
                  input,
                );
              const restoreSleep =
                decision.wakeSignal &&
                (night ||
                  (arousalState === "asleep" &&
                    payload.signals.includes("recheck")));
              if (restoreSleep) {
                await context.registerOnce(
                  "agent.attention.arousal.restore-sleep",
                  candidate.informationId,
                  attentionArousalStateRecordedInformationKind,
                  {
                    payload: {
                      state: "asleep" as const,
                      cause: "policy" as const,
                      scopeKey: payload.scopeKey,
                      candidateInformationId: candidate.informationId,
                      lastEvaluatedAt: now,
                      lastInboundInformationId: state.payload
                        .lastInboundInformationId as string | null,
                      lastActivityAt: String(state.payload.lastActivityAt),
                      sleepStartedAt:
                        (previousState?.payload.sleepStartedAt as
                          string | null) ?? now,
                      lastPeriodicWakeAt:
                        (state.payload.lastPeriodicWakeAt as string | null) ??
                        null,
                      reasonCodes: [
                        night ? "night-sleep" : "periodic-wake-completed",
                      ],
                      policyVersion: "attention-observation.v1" as const,
                    },
                    references: [
                      {
                        relation: "core:uses-context",
                        informationId: state.informationId,
                      },
                    ],
                  },
                );
              } else if (
                decision.arousalState === "awake" &&
                settings.idleSleepEnabled
              )
                await armTimer(
                  state,
                  context,
                  "idle-sleep",
                  new Date(
                    Date.parse(String(state.payload.lastActivityAt)) +
                      settings.idleSleepAfterMs,
                  ).toISOString(),
                );
              await armNightBoundary(state, context, now);
            },
          ),
          onInformation(
            attentionArousalActivityInformationKind,
            {
              subscriptionId: "attention-arousal.activity",
              delivery: "durable",
            },
            async (activity, context) => {
              const states = (await context.select(
                attentionArousalStateSelector,
              )) as readonly DeepReadonly<InformationAtom>[];
              const previous = states.find(
                (atom) =>
                  atom.kind ===
                  attentionArousalStateRecordedInformationKind.kind,
              );
              const latestActivity = states.find(
                (atom) =>
                  atom.kind === attentionArousalActivityInformationKind.kind,
              );
              const now = context.now().toISOString();
              const activityAt = activity.payload.observedAt;
              const night = isNightSleepTime(
                localTimeOfDay(now, options.timeZone),
                settings,
              );
              const nextState = night
                ? ("asleep" as const)
                : ((previous?.payload.state as
                    AttentionArousalState | undefined) ?? "awake");
              const state = await context.registerOnce(
                "agent.attention.arousal.activity",
                activity.informationId,
                attentionArousalStateRecordedInformationKind,
                {
                  payload: {
                    state: nextState,
                    cause: "activity" as const,
                    activityInformationId: activity.informationId,
                    lastEvaluatedAt: now,
                    lastInboundInformationId: String(
                      latestActivity?.payload.inboundInformationId ??
                        activity.payload.inboundInformationId,
                    ),
                    lastActivityAt: String(
                      latestActivity?.payload.observedAt ?? activityAt,
                    ),
                    sleepStartedAt:
                      nextState === "asleep"
                        ? ((previous?.payload.sleepStartedAt as
                            string | null) ?? now)
                        : null,
                    lastPeriodicWakeAt:
                      (previous?.payload.lastPeriodicWakeAt as string | null) ??
                      null,
                    reasonCodes: [
                      night ? "night-sleep" : "global-message-activity",
                    ],
                    policyVersion: "attention-observation.v1" as const,
                  },
                  references: [],
                },
              );
              if (nextState === "asleep")
                await armPeriodicWake(state, context, now);
              else if (settings.idleSleepEnabled)
                await armTimer(
                  state,
                  context,
                  "idle-sleep",
                  new Date(
                    Date.parse(activityAt) + settings.idleSleepAfterMs,
                  ).toISOString(),
                );
              await armNightBoundary(state, context, now);
            },
          ),
          onInformation(
            oneShotDueInformationKind,
            { subscriptionId: "attention-arousal.timer", delivery: "durable" },
            async (due, context) => {
              const selected = (await context.select(
                attentionArousalTimerSelector,
              )) as readonly DeepReadonly<InformationAtom>[];
              const request = selected.find(
                (atom) =>
                  atom.kind === oneShotRequestedInformationKind.kind &&
                  atom.informationId === due.payload.scheduleInformationId &&
                  (atom.payload as any).activation?.instanceId ===
                    context.instanceId,
              );
              if (!request) return;
              const purpose = (request.payload as any).input?.purpose as
                TimerPurpose | undefined;
              if (!purpose) return;
              const result = await scheduler.finish({
                scheduleInformationId: due.payload.scheduleInformationId,
                status: "fired",
              });
              if (result.status !== "fired") return;
              const previous = selected.find(
                (atom) =>
                  atom.kind ===
                  attentionArousalStateRecordedInformationKind.kind,
              );
              const latestActivity = selected.find(
                (atom) =>
                  atom.kind === attentionArousalActivityInformationKind.kind,
              );
              const now = context.now().toISOString();
              const lastActivityAt = String(
                latestActivity?.payload.observedAt ??
                  previous?.payload.lastActivityAt ??
                  now,
              );
              const lastInboundInformationId =
                (latestActivity?.payload.inboundInformationId as
                  string | undefined) ??
                (previous?.payload.lastInboundInformationId as string | null) ??
                null;
              const lastPeriodicWakeAt =
                (previous?.payload.lastPeriodicWakeAt as string | null) ?? null;
              const record = async (
                state: AttentionArousalState,
                reason: string,
                overrides: Record<string, unknown> = {},
              ) =>
                context.registerOnce(
                  "agent.attention.arousal.timer",
                  due.informationId,
                  attentionArousalStateRecordedInformationKind,
                  {
                    payload: {
                      state,
                      cause: "timer" as const,
                      timerInformationId: due.informationId,
                      lastEvaluatedAt: now,
                      lastInboundInformationId,
                      lastActivityAt,
                      sleepStartedAt:
                        state === "asleep"
                          ? ((previous?.payload.sleepStartedAt as
                              string | null) ?? now)
                          : null,
                      lastPeriodicWakeAt,
                      reasonCodes: [reason],
                      policyVersion: "attention-observation.v1" as const,
                      ...overrides,
                    },
                    references: [],
                  },
                );

              if (purpose === "idle-sleep") {
                if (
                  settings.idleSleepEnabled &&
                  Date.parse(now) - Date.parse(lastActivityAt) >=
                    settings.idleSleepAfterMs
                ) {
                  const state = await record("asleep", "global-idle-sleep");
                  await armPeriodicWake(state, context, now);
                  await armNightBoundary(state, context, now);
                }
              } else if (purpose === "periodic-wake") {
                if (
                  settings.periodicWakeEnabled &&
                  previous?.payload.state === "asleep"
                ) {
                  const state = await record("asleep", "periodic-wake", {
                    lastPeriodicWakeAt: now,
                  });
                  await armPeriodicWake(state, context, now);
                }
              } else {
                const night = isNightSleepTime(
                  localTimeOfDay(now, options.timeZone),
                  settings,
                );
                const idle =
                  settings.idleSleepEnabled &&
                  Date.parse(now) - Date.parse(lastActivityAt) >=
                    settings.idleSleepAfterMs;
                const asleep = night || idle;
                const state = await record(
                  asleep ? "asleep" : "awake",
                  night
                    ? "night-sleep"
                    : idle
                      ? "global-idle-sleep"
                      : "night-ended",
                );
                if (asleep) await armPeriodicWake(state, context, now);
                else if (settings.idleSleepEnabled)
                  await armTimer(
                    state,
                    context,
                    "idle-sleep",
                    new Date(
                      Date.parse(lastActivityAt) + settings.idleSleepAfterMs,
                    ).toISOString(),
                  );
                await armNightBoundary(state, context, now);
              }
            },
          ),
        ],
      };
    },
  });
}

export const attentionArousalModule = createAttentionArousalModule({
  timeZone: "Asia/Shanghai",
});
