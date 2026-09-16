/**
 * 功能概述：turn 领域的 Information schema 与不可变定义，独立维护本领域引用和日志投影。
 * 主要职责：下列 schema 校验入账载荷，各 kind 声明因果关系、上下文和诊断元数据；无 I/O。
 * 代码库关系：information-kinds.ts 稳定重导出公共对象；跨领域只复用相邻文件定义，保持 Registry 对象身份。
 */
import { z } from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";
import { nonBlankString, messageSourceSchema } from "./shared.js";
import { inboundTextInformationKind } from "./message.js";

const turnIdentitySchema = z
  .object({
    terminalInformationId: nonBlankString,
    status: z.enum([
      "complete",
      "unresolved",
      "ambiguous",
      "degraded",
      "failed",
    ]),
    scopeMode: z.enum(["canonical", "ephemeral"]),
    scopeInformationId: nonBlankString.optional(),
    accountInformationId: nonBlankString.optional(),
    personInformationId: nonBlankString.optional(),
  })
  .strict();

const turnInputSchema = z
  .object({
    informationId: nonBlankString,
    occurredAt: z.iso.datetime({ offset: true }),
    text: z.string(),
    source: messageSourceSchema,
    identity: turnIdentitySchema,
  })
  .strict();

export const turnClaimedInformationKind = defineInformationKind({
  kind: "agent.turn.claimed",
  displayName: "回合认领",
  description:
    "Heartflow 成功认领候选时记录范围、代次和前一终态；后续上下文及终态引用它以隔离并发回合。",
  payloadSchema: z
    .object({
      candidateInformationId: nonBlankString,
      scopeKey: nonBlankString,
      generation: z.number().int().nonnegative(),
      predecessorTerminalInformationId: nonBlankString.nullable(),
    })
    .strict(),
  references: {
    "core:uses-context": {
      required: false,
      multiple: true,
      targetKinds: [inboundTextInformationKind.kind],
    },
    "core:caused-by": {
      required: true,
      multiple: false,
    },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
    "agent:turn-candidate": {
      required: true,
      multiple: false,
      targetKinds: ["agent.turn.candidate"],
    },
  },
  log: {
    enabled: true,
    level: "trace",
    project: ({ payload }) => {
      const input = payload as any;
      return {
        event: "turn.claimed",
        scopeKey: input.scopeKey,
        generation: input.generation,
      };
    },
  },
});

export const turnStartedInformationKind = defineInformationKind({
  kind: "agent.turn.started",
  displayName: "回合开始",
  description:
    "候选认领后登记正式推进的回合及代次；供回合生命周期诊断关联候选、认领与后续处理。",
  payloadSchema: z
    .object({
      candidateInformationId: nonBlankString,
      claimInformationId: nonBlankString,
      scopeKey: nonBlankString,
      generation: z.number().int().nonnegative(),
    })
    .strict(),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
    "agent:turn-claim": {
      required: true,
      multiple: false,
      targetKinds: [turnClaimedInformationKind.kind],
    },
  },
  log: {
    enabled: true,
    level: "trace",
    project: ({ payload }) => ({
      event: "turn.started",
      scopeKey: payload.scopeKey,
      generation: payload.generation,
    }),
  },
});

export const turnDecisionSupersededInformationKind = defineInformationKind({
  kind: "agent.turn.decision.superseded",
  displayName: "回合决策被替代",
  description:
    "较新候选替代当前认领的决策时记录替代来源；后续可据此识别过期决策并追溯候选竞争。",
  payloadSchema: z
    .object({
      candidateInformationId: nonBlankString,
      claimInformationId: nonBlankString,
      replacementCandidateInformationId: nonBlankString,
    })
    .strict(),
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: ["agent.turn.candidate"],
    },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
    "core:status-of": {
      required: true,
      multiple: false,
      targetKinds: [turnClaimedInformationKind.kind],
    },
  },
  log: {
    enabled: true,
    level: "info",
    project: () => ({ event: "turn.decision.superseded" }),
  },
});

export const turnDecisionInterruptedInformationKind = defineInformationKind({
  kind: "agent.turn.decision.interrupted",
  displayName: "规划被新消息打断",
  description: "新输入在规划结果提交前赢得决策锁，旧规划结果不得再分派。",
  payloadSchema: z
    .object({
      candidateInformationId: nonBlankString,
      claimInformationId: nonBlankString,
      triggerInformationId: nonBlankString,
      rebuildAttempt: z.number().int().min(1),
    })
    .strict(),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
    "core:status-of": {
      required: true,
      multiple: false,
      targetKinds: [turnClaimedInformationKind.kind],
    },
    "core:uses-context": {
      required: true,
      multiple: false,
      targetKinds: [inboundTextInformationKind.kind],
    },
  },
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => ({
      event: "turn.decision.interrupted",
      rebuildAttempt: payload.rebuildAttempt,
    }),
  },
});

const turnTerminalReferences = {
  "core:caused-by": { required: true, multiple: false },
  "core:context": {
    required: true,
    multiple: false,
    targetKinds: ["core.runtime.context"],
  },
  "core:status-of": {
    required: true,
    multiple: false,
    targetKinds: ["agent.turn.candidate"],
  },
  "agent:turn-claim": {
    required: true,
    multiple: false,
    targetKinds: [turnClaimedInformationKind.kind],
  },
} as const;

const turnTerminalBaseShape = {
  candidateInformationId: nonBlankString,
  claimInformationId: nonBlankString,
  scopeKey: nonBlankString,
};

export const turnCompletedInformationKind = defineInformationKind({
  kind: "agent.turn.completed",
  displayName: "回合完成",
  description:
    "回合在投递终态后结束时登记，并保存对应投递终态标识；用于闭合回合生命周期和后续候选衔接。",
  payloadSchema: z
    .object({
      ...turnTerminalBaseShape,
      deliveryTerminalInformationId: nonBlankString,
    })
    .strict(),
  references: turnTerminalReferences,
  log: {
    enabled: true,
    level: "info",
    project: () => ({ event: "turn.lifecycle", status: "completed" }),
  },
});

export const turnWaitingInformationKind = defineInformationKind({
  kind: "agent.turn.waiting",
  displayName: "回合等待",
  description:
    "回合选择暂缓时记录下次检查时间并形成当前回合终态；心跳调度负责后续唤醒，诊断可区分等待与卡住。",
  payloadSchema: z
    .object({
      ...turnTerminalBaseShape,
      dueAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
  references: turnTerminalReferences,
  log: {
    enabled: true,
    level: "trace",
    project: ({ payload }) => ({
      event: "turn.lifecycle",
      status: "waiting",
      dueAt: payload.dueAt,
    }),
  },
});

export const turnSilentInformationKind = defineInformationKind({
  kind: "agent.turn.silent",
  displayName: "回合静默",
  description:
    "回合决定不发言时记录原因并闭合当前候选；供生命周期审计解释本次没有消息输出。",
  payloadSchema: z
    .object({ ...turnTerminalBaseShape, reasonCodes: z.array(nonBlankString) })
    .strict(),
  references: turnTerminalReferences,
  log: {
    enabled: true,
    level: "info",
    project: () => ({ event: "turn.lifecycle", status: "silent" }),
  },
});

export const turnFailedInformationKind = defineInformationKind({
  kind: "agent.turn.failed",
  displayName: "回合失败",
  description:
    "回合无法继续推进时记录失败原因及所属认领；可靠执行和诊断可据此识别已结束的失败候选。",
  payloadSchema: z
    .object({ ...turnTerminalBaseShape, reason: nonBlankString })
    .strict(),
  references: turnTerminalReferences,
  log: {
    enabled: true,
    level: "warn",
    project: ({ payload }) => ({
      event: "turn.lifecycle",
      status: "failed",
      reason: payload.reason,
    }),
  },
});

export const turnSupersededInformationKind = defineInformationKind({
  kind: "agent.turn.superseded",
  displayName: "回合被替代",
  description:
    "回合被更新候选取代时记录替代候选并结束旧回合；下游按新的候选继续推进，避免把旧回合当作待处理。",
  payloadSchema: z
    .object({
      ...turnTerminalBaseShape,
      replacementCandidateInformationId: nonBlankString,
    })
    .strict(),
  references: turnTerminalReferences,
  log: {
    enabled: true,
    level: "info",
    project: () => ({ event: "turn.lifecycle", status: "superseded" }),
  },
});

export const turnInterruptedInformationKind = defineInformationKind({
  kind: "agent.turn.interrupted",
  displayName: "回合被新消息中断",
  description: "关闭已冻结但尚未完成规划的旧回合；后继候选按新消息重新构造。",
  payloadSchema: z
    .object({
      ...turnTerminalBaseShape,
      triggerInformationId: nonBlankString,
      rebuildAttempt: z.number().int().min(1),
    })
    .strict(),
  references: turnTerminalReferences,
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => ({
      event: "turn.lifecycle",
      status: "interrupted",
      rebuildAttempt: payload.rebuildAttempt,
    }),
  },
});

const turnContextPayloadSchema = z
  .object({
    candidateInformationId: nonBlankString,
    claimInformationId: nonBlankString,
    scopeKey: nonBlankString,
    asOf: z.iso.datetime({ offset: true }),
    backlog: z
      .object({
        isBacklog: z.boolean(),
        evaluatedAt: z.iso.datetime({ offset: true }),
        oldestInputAgeMs: z.number().int().min(0),
        newestInputAgeMs: z.number().int().min(0),
        thresholdMs: z.number().int().min(0),
      })
      .strict(),
    inputs: z.array(turnInputSchema).min(1),
    text: z.string(),
    source: messageSourceSchema,
    messageCount: z.number().int().min(0),
    isPrivate: z.boolean(),
    isGroup: z.boolean(),
    mentionedSelf: z.boolean(),
    repliedToSelf: z.boolean(),
    namedSelf: z.boolean(),
    focusActive: z.boolean().optional(),
    focusInformationId: nonBlankString.optional(),
    focusExpiresAt: z.iso.datetime({ offset: true }).optional(),
    recentSelfReplies: z.number().int().min(0),
    recentWindowMessages: z.number().int().min(0),
    idleReachedAverage: z.boolean(),
    frequency: z.number().min(0).max(1),
    frequencyRuleIndex: z.number().int().min(0).nullable().optional(),
    muted: z.boolean(),
    safe: z.boolean(),
    destinationAvailable: z.boolean(),
    stale: z.boolean(),
    /** Optional enrichments are intentionally advisory and do not affect timing. */
    memory: z.array(nonBlankString).optional(),
    association: z.array(nonBlankString).optional(),
    recheckAt: nonBlankString.optional(),
    attempt: z.number().int().min(0),
    totalWaitBudget: z.number().int().min(0),
  })
  .strict() as any;

export type TurnContextCompletedPayload = z.infer<
  typeof turnContextPayloadSchema
>;

export const turnContextCompletedInformationKind = defineInformationKind({
  kind: "agent.turn.context.completed",
  displayName: "回合上下文就绪",
  description:
    "身份屏障结束后冻结输入、来源、时机及积压年龄；注意力评估与规划只消费这份可重放上下文，语义时效由 Planner 判断。",
  payloadSchema: turnContextPayloadSchema,
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
    "core:uses-context": { required: true, multiple: true },
    "agent:turn-claim": {
      required: true,
      multiple: false,
      targetKinds: ["agent.turn.claimed"],
    },
  },
  log: {
    enabled: true,
    level: "trace",
    project: ({ payload }) => {
      const input = payload as any;
      return {
        event: "turn.context.completed",
        messageCount: input.messageCount,
        direct: input.mentionedSelf || input.repliedToSelf || input.namedSelf,
        frequency: input.frequency,
      };
    },
  },
});

const attentionArousalPayloadSchema = z
  .object({
    outcome: z.enum(["attend", "defer", "ignore"]),
    text: z.string(),
    source: messageSourceSchema,
    candidateInformationId: nonBlankString,
    claimInformationId: nonBlankString,
    turnContextInformationId: nonBlankString,
    score: z.number(),
    threshold: z.number().int().min(0).max(100),
    components: z
      .object({
        relevance: z.number(),
        content: z.number(),
        pressure: z.number(),
        recentPresencePenalty: z.number(),
        frequencyFactor: z.number(),
        preFrequencyScore: z.number(),
      })
      .strict(),
    reasonCodes: z.array(nonBlankString),
    missingInputs: z.array(nonBlankString),
    policyDigest: nonBlankString,
    settingsDigest: nonBlankString,
    dueAt: nonBlankString.optional(),
    delayMs: z.number().int().min(0).optional(),
    attempt: z.number().int().min(0),
    totalWaitBudget: z.number().int().min(0),
    wakePolicy: z.literal("recheckAt").optional(),
  })
  .strict() as any;

export type AttentionArousalPayload = z.infer<
  typeof attentionArousalPayloadSchema
>;

export const attentionArousalCompletedInformationKind = defineInformationKind({
  kind: "agent.attention.arousal.completed",
  displayName: "注意力评估结果",
  description:
    "对冻结回合完成安全门控及显著性评分后记录关注、延后或忽略、分项得分和原因；Heartflow 据此进入规划或结束回合。",
  payloadSchema: attentionArousalPayloadSchema,
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [turnContextCompletedInformationKind.kind],
    },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
    "core:uses-context": { required: true, multiple: true },
    "agent:turn-claim": {
      required: true,
      multiple: false,
      targetKinds: ["agent.turn.claimed"],
    },
    "core:status-of": {
      required: true,
      multiple: false,
      targetKinds: ["agent.turn.claimed"],
    },
  },
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => {
      const input = payload as any;
      return {
        event: "turn.decision",
        outcome: input.outcome,
        score: input.score,
        reasonCodes: input.reasonCodes,
        missingInputs: input.missingInputs,
        attempt: input.attempt,
        totalWaitBudget: input.totalWaitBudget,
        ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
        ...(input.delayMs === undefined ? {} : { delayMs: input.delayMs }),
      };
    },
  },
});

export const waitRequestedInformationKind = defineInformationKind({
  kind: "agent.wait.requested",
  displayName: "等待唤醒请求",
  description:
    "回合需要稍后复查时记录到期时间、等待预算和消息唤醒策略；心跳模块据此创建可恢复调度。",
  payloadSchema: z
    .object({
      dueAt: nonBlankString,
      delayMs: z.number().int().min(0),
      reason: nonBlankString,
      attempt: z.number().int().min(0),
      totalWaitBudget: z.number().int().min(0),
      wakePolicy: z.enum(["recheckAt", "cooldown"]),
      wakeOnMessage: z.boolean(),
      source: messageSourceSchema,
      sourceInformationIds: z.array(nonBlankString).min(1),
    })
    .strict() as any,
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [attentionArousalCompletedInformationKind.kind],
    },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
    "core:uses-context": {
      required: true,
      multiple: true,
      targetKinds: [inboundTextInformationKind.kind],
    },
  },
  log: {
    enabled: true,
    level: "trace",
    project: ({ payload }) => {
      const input = payload as any;
      return {
        event: "speech.wait.requested",
        dueAt: input.dueAt,
        delayMs: input.delayMs,
        reason: input.reason,
      };
    },
  },
});
