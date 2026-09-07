/**
 * 功能概述：本文件声明 modules 包拥有的消息 DAG kind，明确区分入站、过滤通过后的
 * 回复请求、过滤拒绝、Memory、person-fact 候选/提取结果、assistant 文本和平台投递请求，
 * 替代旧事件与定向回复语义。
 * 主要职责：每个 definition 固定 payload 的严格 schema 和直接因果/context 引用规则；
 * `personFactCandidateInformationKind` 表示待提取的非 reply 账本来源，
 * `personFactExtractedInformationKind` 表示模块验证后的业务事实；`informationModuleKinds`
 * 供 Runtime 在启动 Core 前一次注册同一批 definition。
 * 代码库关系：speech reply bridge 是回复请求的唯一生产路径；LLM 回复模块消费回复请求、外部
 * 注入的 Model Task completed definition 与 assistant，person-fact 模块消费候选与通用 completed，
 * 随后产生各自后续 kind；Runtime 负责通用
 * Model Task 生命周期和投递结果 kind，不能重新定义本文件已经拥有的 literal kind；assistant payload
 * 记录 originating module instance，使全量广播后的下一阶段只由原实例派生。
 * 输入输出与副作用：由 `defineInformationKind` 返回的 definition 为冻结的纯定义，无 I/O；
 * Zod schema 与数组仍按各自库的常规语义使用。payload 和引用在 Core 注册前受校验，模块宿主
 * 会自动补齐 `core:caused-by` 与继承的 `core:context`。
 */
import {
  outboundMessageContentSchema,
  platformDestinationSchema,
  z,
} from "@kaguya/schema";
import {
  defineInformationKind,
  type InformationKindDefinition,
} from "@kaguya/sdk";

const nonBlankString = z.string().trim().min(1);

const CONTENT_PREVIEW_LENGTH = 168;
function contentPreview(text: string) {
  const codePoints = Array.from(text);
  const truncated = codePoints.length > CONTENT_PREVIEW_LENGTH;
  return {
    contentPreview: sanitizeLoggedContent(
      codePoints
        .slice(0, CONTENT_PREVIEW_LENGTH)
        .map((point) => {
          const value = point.codePointAt(0) ?? 0;
          return value < 0x20 && point !== "\n" && point !== "\t"
            ? `\\u${value.toString(16).padStart(4, "0")}`
            : point;
        })
        .join("") + (truncated ? "…" : ""),
    ),
    contentLength: codePoints.length,
    contentTruncated: truncated,
  };
}

function sanitizeLoggedContent(text: string): string {
  return text
    .replace(
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s]+/giu,
      "[REDACTED]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]")
    .replace(
      /\b(api[_-]?key|authorization|token|password|secret|credential)\s*[:=]\s*[^\s]+/giu,
      "$1=[REDACTED]",
    )
    .replace(/\bBearer\s+[^\s]+/giu, "Bearer [REDACTED]")
    .replace(
      /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gu,
      "[REDACTED PRIVATE MATERIAL]",
    );
}

const messageSourceSchema = z
  .object({
    adapterId: nonBlankString,
    platform: nonBlankString,
    platformMessageId: nonBlankString,
    destination: platformDestinationSchema,
    senderId: nonBlankString,
    sender: z
      .object({
        userId: nonBlankString,
        nickname: nonBlankString.optional(),
        card: nonBlankString.optional(),
        isSelf: z.boolean().optional(),
      })
      .strict()
      .optional(),
    selfId: nonBlankString.optional(),
    mentions: z
      .array(
        z.union([
          z.object({ kind: z.literal("user"), id: nonBlankString }).strict(),
          z.object({ kind: z.literal("all") }).strict(),
        ]),
      )
      .optional(),
    replyTo: z
      .object({
        platformMessageId: nonBlankString,
        senderId: nonBlankString.optional(),
      })
      .strict()
      .optional(),
  })
  .strict() as any;

export const replyRequestedInformationPayloadSchema = z
  .object({
    text: z.string(),
    source: messageSourceSchema,
  })
  .strict() as any;
export type ReplyRequestedInformationPayload = z.infer<
  typeof replyRequestedInformationPayloadSchema
>;

export const inboundTextInformationKind = defineInformationKind({
  kind: "core.message.inbound.text",
  payloadSchema: replyRequestedInformationPayloadSchema,
  references: {
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
  },
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => {
      const input = payload as any;
      return {
        event: "message.inbound",
        adapterId: input.source.adapterId,
        platform: input.source.platform,
        ...contentPreview(input.text),
      };
    },
  },
});

export const replyRequestedInformationKind = defineInformationKind({
  kind: "core.reply.requested",
  payloadSchema: replyRequestedInformationPayloadSchema,
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: ["agent.speech.decision"],
    },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
    "core:uses-context": {
      required: true,
      multiple: true,
      targetKinds: ["agent.turn.context.completed"],
    },
  },
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => {
      const input = payload as any;
      return {
        event: "reply.requested",
        adapterId: input.source.adapterId,
        platform: input.source.platform,
        ...contentPreview(input.text),
      };
    },
  },
});

export const filterDecisionInformationKind = defineInformationKind({
  kind: "filter.decision",
  payloadSchema: z
    .object({
      accepted: z.literal(false),
      reason: nonBlankString,
      filterDefinitionId: nonBlankString,
    })
    .strict(),
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [inboundTextInformationKind.kind],
    },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
  },
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => ({
      event: "filter.decision",
      status: "rejected",
      reason: payload.reason,
      filterDefinitionId: payload.filterDefinitionId,
    }),
  },
});

export const coreMemoryTextInformationKind = defineInformationKind({
  kind: "core.memory.text",
  payloadSchema: z.object({ text: z.string().trim().min(1) }).strict(),
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
    },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
    "core:uses-context": {
      required: true,
      multiple: true,
    },
  },
  log: {
    enabled: true,
    level: "debug",
    project: () => ({ event: "memory.text.registered" }),
  },
});

const associationRouteSchema = z.literal("reply");
const associationMethodSchema = z.literal("sparse-2gram");
const associationStatusSchema = z.enum([
  "matched",
  "empty",
  "policy-filtered",
  "unavailable",
  "failed",
]);
const associationIdentitySchema = z
  .object({
    status: z.enum([
      "complete",
      "unresolved",
      "ambiguous",
      "degraded",
      "failed",
      "unavailable",
    ]),
    personInformationId: nonBlankString.optional(),
    scopeInformationId: nonBlankString.optional(),
  })
  .strict();
const associationScopeSchema = z
  .object({
    platform: nonBlankString,
    adapterId: nonBlankString,
    destination: platformDestinationSchema,
  })
  .strict();

export const associationRequestedInformationPayloadSchema = z
  .object({
    sourceInformationId: nonBlankString,
    queryText: z.string(),
    asOf: z.iso.datetime(),
    route: associationRouteSchema,
    method: associationMethodSchema,
    identity: associationIdentitySchema,
    scope: associationScopeSchema,
  })
  .strict() as any;
export type AssociationRequestedInformationPayload = z.infer<
  typeof associationRequestedInformationPayloadSchema
>;

export const associationRequestedInformationKind = defineInformationKind({
  kind: "agent.association.requested",
  payloadSchema: associationRequestedInformationPayloadSchema,
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [replyRequestedInformationKind.kind],
    },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
    "agent:identity-terminal": {
      required: false,
      multiple: false,
      targetKinds: ["agent.person.context.completed"],
    },
  },
  log: {
    enabled: true,
    level: "debug",
    project: ({ payload }) => {
      const input = payload as any;
      return {
        event: "association.requested",
        route: input.route,
        method: input.method,
        identityStatus: input.identity.status,
      };
    },
  },
});

export const associationQueryInformationPayloadSchema = z
  .object({
    requestInformationId: nonBlankString,
    sourceInformationId: nonBlankString,
    queryText: z.string(),
    query: z.string(),
    asOf: z.iso.datetime(),
    route: associationRouteSchema,
    method: associationMethodSchema,
    identity: associationIdentitySchema,
    scope: associationScopeSchema,
    limit: z.number().int().min(1).max(10),
  })
  .strict() as any;
export type AssociationQueryInformationPayload = z.infer<
  typeof associationQueryInformationPayloadSchema
>;

export const associationQueryInformationKind = defineInformationKind({
  kind: "agent.association.query",
  payloadSchema: associationQueryInformationPayloadSchema,
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [associationRequestedInformationKind.kind],
    },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
  },
  log: {
    enabled: true,
    level: "debug",
    project: ({ payload }) => {
      const input = payload as any;
      return {
        event: "association.query",
        route: input.route,
        method: input.method,
        queryLength: Array.from(input.query as string).length,
        limit: input.limit,
      };
    },
  },
});

export const associationCandidateInformationPayloadSchema = z
  .object({
    rank: z.number().int().nonnegative(),
    route: z.literal("memory"),
    strategy: associationMethodSchema,
    reasonCodes: z.array(nonBlankString).min(1),
  })
  .strict();
export type AssociationCandidateInformationPayload = z.infer<
  typeof associationCandidateInformationPayloadSchema
>;

export const associationCandidateInformationKind = defineInformationKind({
  kind: "agent.association.candidate",
  payloadSchema: associationCandidateInformationPayloadSchema,
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [associationQueryInformationKind.kind],
    },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
    "agent:request": {
      required: true,
      multiple: false,
      targetKinds: [associationRequestedInformationKind.kind],
    },
    "agent:canonical-source": {
      required: true,
      multiple: false,
      targetKinds: [
        coreMemoryTextInformationKind.kind,
        inboundTextInformationKind.kind,
      ],
    },
  },
  log: {
    enabled: true,
    level: "debug",
    project: ({ payload }) => ({
      event: "association.candidate",
      rank: payload.rank,
      strategy: payload.strategy,
      reasonCodes: payload.reasonCodes,
    }),
  },
});

export const associationCompletedInformationPayloadSchema = z
  .object({
    requestInformationId: nonBlankString,
    queryInformationId: nonBlankString,
    sourceInformationId: nonBlankString,
    route: associationRouteSchema,
    method: associationMethodSchema,
    status: associationStatusSchema,
    candidateCount: z.number().int().nonnegative(),
    reasonCodes: z.array(nonBlankString).min(1),
  })
  .strict();
export type AssociationCompletedInformationPayload = z.infer<
  typeof associationCompletedInformationPayloadSchema
>;

export const associationCompletedInformationKind = defineInformationKind({
  kind: "agent.association.completed",
  payloadSchema: associationCompletedInformationPayloadSchema,
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [associationQueryInformationKind.kind],
    },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
    "agent:request": {
      required: true,
      multiple: false,
      targetKinds: [associationRequestedInformationKind.kind],
    },
    "agent:candidate": {
      required: false,
      multiple: true,
      targetKinds: [associationCandidateInformationKind.kind],
    },
  },
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => ({
      event: "association.completed",
      status: payload.status,
      route: payload.route,
      method: payload.method,
      candidateCount: payload.candidateCount,
      reasonCodes: payload.reasonCodes,
    }),
  },
});

export const personFactCandidateInformationPayloadSchema = z
  .object({
    personId: nonBlankString,
    name: nonBlankString,
    text: nonBlankString,
  })
  .strict();
export type PersonFactCandidateInformationPayload = z.infer<
  typeof personFactCandidateInformationPayloadSchema
>;

export const personFactCandidateInformationKind = defineInformationKind({
  kind: "core.person.fact.candidate",
  payloadSchema: personFactCandidateInformationPayloadSchema,
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
    },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
  },
  log: {
    enabled: true,
    level: "debug",
    project: () => ({ event: "person.fact.candidate" }),
  },
});

export const personFactExtractedPayloadSchema = z
  .object({
    personId: nonBlankString,
    name: nonBlankString,
    fact: nonBlankString,
  })
  .strict();
export type PersonFactExtractedPayload = z.infer<
  typeof personFactExtractedPayloadSchema
>;

export const personFactExtractedInformationKind = defineInformationKind({
  kind: "core.person.fact.extracted",
  payloadSchema: personFactExtractedPayloadSchema,
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: ["core.model.task.completed"],
    },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
  },
  log: {
    enabled: true,
    level: "info",
    project: () => ({ event: "person.fact.extracted" }),
  },
});

export const assistantTextInformationKind = defineInformationKind({
  kind: "core.message.assistant.text",
  payloadSchema: z
    .object({
      text: z.string(),
      source: messageSourceSchema,
      originatingModuleInstanceId: nonBlankString,
    })
    .strict(),
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: ["core.model.task.completed"],
    },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
  },
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => ({
      event: "message.assistant",
      originatingModuleInstanceId: payload.originatingModuleInstanceId,
      ...contentPreview(payload.text),
    }),
  },
});

export const deliveryRequestedInformationKind = defineInformationKind({
  kind: "core.delivery.requested",
  payloadSchema: z
    .object({
      adapterId: nonBlankString,
      platform: nonBlankString,
      destination: platformDestinationSchema,
      message: outboundMessageContentSchema,
    })
    .strict(),
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [assistantTextInformationKind.kind],
    },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
  },
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => ({
      event: "delivery.requested",
      adapterId: payload.adapterId,
      platform: payload.platform,
      messageKind: payload.message.kind,
    }),
  },
});

const turnContextPayloadSchema = z
  .object({
    candidateInformationId: nonBlankString,
    asOf: nonBlankString.optional(),
    text: z.string(),
    source: messageSourceSchema,
    directness: z.number().min(0).max(1),
    contentNeed: z.number().min(0).max(1),
    messageCount: z.number().int().min(0),
    recentPresencePenalty: z.number().min(0).max(1),
    frequencyMultiplier: z.number().min(0).max(1),
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
  payloadSchema: turnContextPayloadSchema,
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
    "core:uses-context": { required: true, multiple: true },
  },
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => {
      const input = payload as any;
      return {
        event: "turn.context.completed",
        directness: input.directness,
        contentNeed: input.contentNeed,
        messageCount: input.messageCount,
      };
    },
  },
});

const speechDecisionPayloadSchema = z
  .object({
    action: z.enum(["speak", "wait", "silent"]),
    status: z.enum(["decision", "failed", "superseded"]),
    text: z.string(),
    source: messageSourceSchema,
    candidateInformationId: nonBlankString,
    turnContextInformationId: nonBlankString,
    score: z.number(),
    thresholds: z.object({ speak: z.number(), wait: z.number() }).strict(),
    components: z
      .object({
        directness: z.number(),
        contentNeed: z.number(),
        messageCount: z.number(),
        recentPresencePenalty: z.number(),
        frequencyMultiplier: z.number(),
      })
      .strict(),
    reasonCodes: z.array(nonBlankString),
    missingInputs: z.array(nonBlankString),
    policyDigest: nonBlankString,
    settingsDigest: nonBlankString,
    recheckAt: nonBlankString.optional(),
    dueAt: nonBlankString.optional(),
    delayMs: z.number().int().min(0).optional(),
    attempt: z.number().int().min(0),
    totalWaitBudget: z.number().int().min(0),
    wakePolicy: z.enum(["none", "recheckAt", "cooldown"]).optional(),
  })
  .strict() as any;

export type SpeechDecisionPayload = z.infer<typeof speechDecisionPayloadSchema>;

export const speechDecisionInformationKind = defineInformationKind({
  kind: "agent.speech.decision",
  payloadSchema: speechDecisionPayloadSchema,
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
  },
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => {
      const input = payload as any;
      return {
        event: "speech.decision",
        action: input.action,
        status: input.status,
        score: input.score,
        reasonCodes: input.reasonCodes,
        missingInputs: input.missingInputs,
      };
    },
  },
});

export const waitRequestedInformationKind = defineInformationKind({
  kind: "agent.wait.requested",
  payloadSchema: z
    .object({
      dueAt: nonBlankString,
      delayMs: z.number().int().min(0),
      reason: nonBlankString,
      attempt: z.number().int().min(0),
      totalWaitBudget: z.number().int().min(0),
      wakePolicy: z.enum(["recheckAt", "cooldown"]),
      wakeOnMessage: z.boolean().default(true),
      source: messageSourceSchema,
    })
    .strict() as any,
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [speechDecisionInformationKind.kind],
    },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
  },
  log: {
    enabled: true,
    level: "info",
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

const heartbeatReasonSchema = z.enum(["message", "wait"]);
const heartbeatPolicyVersionSchema = z.literal("short-heartbeat.v1");
const heartbeatTerminalReference = {
  "core:status-of": {
    required: true,
    multiple: false,
    targetKinds: ["agent.heartbeat.scheduled"],
  },
} as const;

export const heartbeatScheduledInformationKind = defineInformationKind({
  kind: "agent.heartbeat.scheduled",
  payloadSchema: z
    .object({
      reason: heartbeatReasonSchema,
      dueAt: z.iso.datetime({ offset: true }),
      policyVersion: heartbeatPolicyVersionSchema,
      platform: nonBlankString,
      adapterId: nonBlankString,
      destination: platformDestinationSchema,
      sourceInformationIds: z.array(nonBlankString).min(1),
      wakeOnMessage: z.boolean(),
      attempt: z.number().int().min(0),
      totalWaitBudget: z.number().int().min(0),
      scopeKey: nonBlankString,
    })
    .strict(),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:uses-context": { required: false, multiple: true },
  },
  log: {
    enabled: true,
    level: "debug",
    project: ({ payload }) => ({
      event: "heartbeat.scheduled",
      reason: payload.reason,
      dueAt: payload.dueAt,
      policyVersion: payload.policyVersion,
      sourceCount: payload.sourceInformationIds.length,
      wakeOnMessage: payload.wakeOnMessage,
      attempt: payload.attempt,
      totalWaitBudget: payload.totalWaitBudget,
    }),
  },
});

export const heartbeatFiredInformationKind = defineInformationKind({
  kind: "agent.heartbeat.fired",
  payloadSchema: z
    .object({ firedAt: z.iso.datetime({ offset: true }) })
    .strict(),
  references: heartbeatTerminalReference,
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => ({
      event: "heartbeat.lifecycle",
      status: "fired",
      firedAt: payload.firedAt,
    }),
  },
});

export const heartbeatSupersededInformationKind = defineInformationKind({
  kind: "agent.heartbeat.superseded",
  payloadSchema: z
    .object({ replacementInformationId: nonBlankString })
    .strict(),
  references: heartbeatTerminalReference,
  log: {
    enabled: true,
    level: "debug",
    project: () => ({
      event: "heartbeat.lifecycle",
      status: "superseded",
    }),
  },
});

export const heartbeatFailedInformationKind = defineInformationKind({
  kind: "agent.heartbeat.failed",
  payloadSchema: z.object({ error: nonBlankString }).strict(),
  references: heartbeatTerminalReference,
  log: {
    enabled: true,
    level: "warn",
    project: ({ payload }) => ({
      event: "heartbeat.lifecycle",
      status: "failed",
      error: payload.error,
    }),
  },
});

export const turnCandidateInformationKind = defineInformationKind({
  kind: "agent.turn.candidate",
  payloadSchema: z
    .object({
      heartbeatInformationId: nonBlankString,
      reason: heartbeatReasonSchema,
      dueAt: z.iso.datetime({ offset: true }),
      firedAt: z.iso.datetime({ offset: true }),
      platform: nonBlankString,
      adapterId: nonBlankString,
      destination: platformDestinationSchema,
      sourceInformationIds: z.array(nonBlankString).min(1),
      scopeKey: nonBlankString,
    })
    .strict(),
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: ["core.schedule.one-shot.due"],
    },
    "agent:heartbeat-fired": {
      required: true,
      multiple: false,
      targetKinds: [heartbeatFiredInformationKind.kind],
    },
  },
  log: {
    enabled: true,
    level: "debug",
    project: ({ payload }) => ({
      event: "turn.candidate",
      reason: payload.reason,
      dueAt: payload.dueAt,
      firedAt: payload.firedAt,
      sourceCount: payload.sourceInformationIds.length,
    }),
  },
});

const identityTerminalSchema = z
  .object({
    status: z.enum([
      "complete",
      "unresolved",
      "ambiguous",
      "degraded",
      "failed",
    ]),
    scopeMode: z.enum(["canonical", "ephemeral"]),
    platform: nonBlankString,
    adapterId: nonBlankString,
    scopeInformationId: nonBlankString.optional(),
    accountInformationId: nonBlankString.optional(),
    personInformationId: nonBlankString.optional(),
  })
  .strict() as any;

export const chatScopeEntityInformationKind = defineInformationKind({
  kind: "agent.chat.scope.entity",
  payloadSchema: z
    .object({
      platform: nonBlankString,
      adapterId: nonBlankString,
      destination: platformDestinationSchema,
      scopeMode: z.enum(["canonical", "ephemeral"]),
    })
    .strict(),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
  },
  log: {
    enabled: true,
    level: "debug",
    project: ({ payload }) => ({
      event: "identity.scope.entity",
      platform: payload.platform,
      adapterId: payload.adapterId,
      scopeMode: payload.scopeMode,
    }),
  },
});
export const chatScopeBindingInformationKind = defineInformationKind({
  kind: "agent.chat.scope.binding",
  payloadSchema: z
    .object({
      platform: nonBlankString,
      adapterId: nonBlankString,
      destination: platformDestinationSchema,
    })
    .strict(),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
    "core:binds": {
      required: true,
      multiple: false,
      targetKinds: [chatScopeEntityInformationKind.kind],
    },
  },
  log: {
    enabled: true,
    level: "debug",
    project: ({ payload }) => ({
      event: "identity.scope.binding",
      platform: payload.platform,
      adapterId: payload.adapterId,
    }),
  },
});
export const platformAccountEntityInformationKind = defineInformationKind({
  kind: "agent.platform.account.entity",
  payloadSchema: z
    .object({
      platform: nonBlankString,
      adapterId: nonBlankString,
      accountId: nonBlankString,
    })
    .strict(),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
  },
  log: {
    enabled: true,
    level: "debug",
    project: ({ payload }) => ({
      event: "identity.account.entity",
      platform: payload.platform,
      adapterId: payload.adapterId,
    }),
  },
});
export const platformAccountBindingInformationKind = defineInformationKind({
  kind: "agent.platform.account.binding",
  payloadSchema: z
    .object({ accountId: nonBlankString, personInformationId: nonBlankString })
    .strict(),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
    "core:binds": {
      required: true,
      multiple: false,
      targetKinds: [platformAccountEntityInformationKind.kind],
    },
  },
  log: {
    enabled: true,
    level: "debug",
    project: () => ({ event: "identity.account.binding" }),
  },
});
export const personEntityInformationKind = defineInformationKind({
  kind: "agent.person.entity",
  payloadSchema: z.object({ accountId: nonBlankString }).strict(),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
  },
  log: {
    enabled: true,
    level: "debug",
    project: () => ({ event: "identity.person.entity" }),
  },
});
export const personObservedInformationKind = defineInformationKind({
  kind: "agent.person.observed",
  payloadSchema: z
    .object({
      accountId: nonBlankString,
      nickname: nonBlankString.optional(),
      card: nonBlankString.optional(),
      observedAt: nonBlankString,
    })
    .strict() as any,
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
    "core:observes": {
      required: true,
      multiple: false,
      targetKinds: [platformAccountEntityInformationKind.kind],
    },
  },
  log: {
    enabled: true,
    level: "debug",
    project: ({ payload }) => ({
      event: "identity.person.observed",
      hasNickname: payload.nickname !== undefined,
      hasCard: payload.card !== undefined,
    }),
  },
});
export const personResolutionInformationKind = defineInformationKind({
  kind: "agent.person.resolution",
  payloadSchema: identityTerminalSchema,
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
  },
  log: {
    enabled: true,
    level: "debug",
    project: ({ payload }) => {
      const input = payload as any;
      return {
        event: "identity.person.resolution",
        status: input.status,
        scopeMode: input.scopeMode,
        platform: input.platform,
        adapterId: input.adapterId,
      };
    },
  },
});
export const personContextCompletedInformationKind = defineInformationKind({
  kind: "agent.person.context.completed",
  payloadSchema: identityTerminalSchema,
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
      targetKinds: [inboundTextInformationKind.kind],
    },
  },
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => {
      const input = payload as any;
      return {
        event: "identity.context.completed",
        status: input.status,
        scopeMode: input.scopeMode,
        platform: input.platform,
        adapterId: input.adapterId,
      };
    },
  },
});

export const informationModuleKinds = [
  inboundTextInformationKind,
  replyRequestedInformationKind,
  filterDecisionInformationKind,
  coreMemoryTextInformationKind,
  associationRequestedInformationKind,
  associationQueryInformationKind,
  associationCandidateInformationKind,
  associationCompletedInformationKind,
  personFactCandidateInformationKind,
  personFactExtractedInformationKind,
  assistantTextInformationKind,
  deliveryRequestedInformationKind,
  chatScopeEntityInformationKind,
  chatScopeBindingInformationKind,
  platformAccountEntityInformationKind,
  platformAccountBindingInformationKind,
  personEntityInformationKind,
  personObservedInformationKind,
  personResolutionInformationKind,
  personContextCompletedInformationKind,
  turnContextCompletedInformationKind,
  speechDecisionInformationKind,
  waitRequestedInformationKind,
  heartbeatScheduledInformationKind,
  heartbeatFiredInformationKind,
  heartbeatSupersededInformationKind,
  heartbeatFailedInformationKind,
  turnCandidateInformationKind,
] as const satisfies readonly InformationKindDefinition<string, any>[];
