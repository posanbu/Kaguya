/**
 * 自然语言跨会话 intent 允许由获胜 agent.turn.plan.completed 直接引起，仍需宿主目标授权引用。
 * 功能概述：本文件声明 modules 包拥有的消息 DAG kind，包括入站、Heartbeat、Heartflow
 * claim/context/terminal、speech decision、消息意图、Memory、身份、assistant 与平台投递请求。
 * 主要职责：每个 definition 固定 payload 的严格 schema 和直接因果/context 引用规则；
 * `personFactCandidateInformationKind` 表示待提取的账本来源，
 * `personFactExtractedInformationKind` 表示模块验证后的业务事实；模块 Kind 由各自 Manifest
 * 的 consumes / produces 声明，不在此维护独立注册清单。
 * 代码库关系：Heartflow 的 attend 分支只产生消息意图；composer 消费意图、外部
 * 注入的 Model Task completed definition 与 assistant，person-fact 模块消费候选与通用 completed，
 * 随后产生各自后续 kind；Runtime 负责通用
 * Model Task 生命周期和投递结果 kind，不能重新定义本文件已经拥有的 literal kind；assistant payload
 * 记录 originating module instance，使全量广播后的下一阶段只由原实例派生。
 * 协议边界：intent 严格要求 target、turn、memoryInformationIds，不携带入站正文或回复标记；
 * inbound schema 独立保留入站来源，assistant source 只记录目标及可选 selfId/已投递消息 ID。
 * 跨会话意图引用宿主批准事实，事实本身不授予权限；原有目标/turn/Memory payload 保持一致。
 * messageTargetSchema/MessageTarget 暴露可复用的显式目标契约；
 * association route 固定为 message，其请求直接引用消息意图。
 * 输入输出与副作用：由 `defineInformationKind` 返回的 definition 为冻结的纯定义，无 I/O；
 * Zod schema 与数组仍按各自库的常规语义使用。payload 和引用在 Core 注册前受校验，模块宿主
 * 会自动补齐 `core:caused-by` 与继承的 `core:context`。
 * 展示契约：中文名称与职责说明由定义直接提供给 Inspection 和 WebUI，稳定 kind 与协议字段保持不变。
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

export const turnProvenanceSchema = z
  .object({
    candidateInformationId: nonBlankString,
    claimInformationId: nonBlankString,
    contextInformationId: nonBlankString,
  })
  .strict();

export const messageTargetSchema = z
  .object({
    adapterId: nonBlankString,
    platform: nonBlankString,
    destination: platformDestinationSchema,
  })
  .strict();

export type MessageTarget = z.infer<typeof messageTargetSchema>;

export const inboundTextInformationPayloadSchema = z
  .object({ text: z.string(), source: messageSourceSchema })
  .strict();

export const messageIntentRequestedInformationPayloadSchema = z
  .object({
    target: messageTargetSchema,
    turn: turnProvenanceSchema,
    memoryInformationIds: z.array(nonBlankString),
  })
  .strict();
export type MessageIntentRequestedInformationPayload = z.infer<
  typeof messageIntentRequestedInformationPayloadSchema
>;

export const inboundTextInformationKind = defineInformationKind({
  kind: "core.message.inbound.text",
  displayName: "入站文本消息",
  description:
    "平台适配器接收消息后保存的原始正文和来源；身份归一、心跳聚合与记忆写回据此处理同一条入站信息。",
  payloadSchema: inboundTextInformationPayloadSchema,
  references: {
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
  },
  log: {
    enabled: true,
    level: "trace",
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

export const messageIntentRequestedInformationKind = defineInformationKind({
  kind: "agent.message.intent.requested",
  displayName: "消息生成意图",
  description:
    "回合规划选择发言后提出的生成请求，固定目标、回合来源和获准记忆；联想模块据此召回记忆，消息合成模块据此选择上下文并生成正文。",
  payloadSchema: messageIntentRequestedInformationPayloadSchema,
  references: {
    "agent:target-authorization": {
      required: false,
      multiple: false,
      targetKinds: ["agent.message.target.authorized"],
    },
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [
        "agent.attention.arousal.completed",
        "agent.turn.plan.completed",
        "agent.message.target.authorized",
      ],
    },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
    "core:uses-context": {
      required: true,
      multiple: true,
      targetKinds: [
        "agent.turn.context.completed",
        "agent.message.target.authorized",
      ],
    },
    "agent:turn-claim": {
      required: true,
      multiple: false,
      targetKinds: ["agent.turn.claimed"],
    },
    "agent:turn-candidate": {
      required: true,
      multiple: false,
      targetKinds: ["agent.turn.candidate"],
    },
  },
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => {
      const input = payload;
      return {
        event: "message.intent.requested",
        adapterId: input.target.adapterId,
        platform: input.target.platform,
      };
    },
  },
});

export const filterDecisionInformationKind = defineInformationKind({
  kind: "filter.decision",
  displayName: "入站过滤拒绝",
  description:
    "入站消息被过滤器拒绝时记录过滤器标识和原因；用于审计消息为何未进入后续处理。",
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
  displayName: "记忆文本",
  description:
    "带显式来源引用的记忆正文，登记后供联想检索及 Prompt 上下文选择使用，来源可沿引用追溯。",
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

const associationRouteSchema = z.literal("message");
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
  displayName: "记忆联想请求",
  description:
    "收到消息意图后冻结检索范围、身份和时间边界；联想处理据此构造查询，避免使用范围外或迟到信息。",
  payloadSchema: associationRequestedInformationPayloadSchema,
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [messageIntentRequestedInformationKind.kind],
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
  displayName: "记忆联想查询",
  description:
    "联想请求被处理时记录实际查询文本、方法、范围和数量上限；检索结果以此作为候选的直接来源。",
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
  displayName: "记忆联想候选",
  description:
    "检索命中后记录候选排名与入选原因，并引用原始记忆；消息上下文选择器沿引用读取获准材料。",
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
  displayName: "记忆联想结果",
  description:
    "一次联想结束时汇总命中、空结果、策略过滤或故障及候选数量；消息合成模块据此继续生成，不将空结果误判为尚未完成。",
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
  displayName: "人物事实候选",
  description:
    "待提取人物事实的文本及其来源，在提交提取任务前登记；人物事实模块将其渲染为模型输入并校验输出证据。",
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
  displayName: "人物事实提取结果",
  description:
    "人物提取模型的输出通过结构和证据校验后登记的事实；下游可沿来源引用核查，不将未验证的模型文本作为事实。",
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
  displayName: "生成的助手消息",
  description:
    "消息合成完成后保存的正文、目标和生成实例；下游将其转成投递请求，登记本身不表示平台已发送成功。",
  payloadSchema: z
    .object({
      text: z.string(),
      source: messageTargetSchema
        .extend({
          selfId: nonBlankString.optional(),
          platformMessageId: nonBlankString.optional(),
        })
        .strict() as z.ZodType<
        MessageTarget & {
          selfId?: string;
          platformMessageId?: string;
        }
      >,
      originatingModuleInstanceId: nonBlankString,
      turn: turnProvenanceSchema.nullable(),
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
    project: ({ payload }) => {
      const input = payload as any;
      return {
        event: "message.assistant",
        originatingModuleInstanceId: input.originatingModuleInstanceId,
        ...contentPreview(input.text),
      };
    },
  },
});

export const deliveryRequestedInformationKind = defineInformationKind({
  kind: "core.delivery.requested",
  displayName: "平台投递请求",
  description:
    "助手正文进入发送阶段时记录明确目标、消息内容和回合来源；Runtime 调用对应适配器并产生成功或失败结果。",
  payloadSchema: z
    .object({
      adapterId: nonBlankString,
      platform: nonBlankString,
      destination: platformDestinationSchema,
      message: outboundMessageContentSchema,
      turn: turnProvenanceSchema.nullable(),
    })
    .strict(),
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [
        assistantTextInformationKind.kind,
        "agent.message.content.confirmed",
      ],
    },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
    "agent:turn-claim": {
      required: false,
      multiple: false,
      targetKinds: ["agent.turn.claimed"],
    },
    "agent:turn-candidate": {
      required: false,
      multiple: false,
      targetKinds: ["agent.turn.candidate"],
    },
  },
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => {
      const input = payload as any;
      return {
        event: "delivery.requested",
        adapterId: input.adapterId,
        platform: input.platform,
        messageKind: input.message.kind,
      };
    },
  },
});

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

const turnContextPayloadSchema = z
  .object({
    candidateInformationId: nonBlankString,
    claimInformationId: nonBlankString,
    scopeKey: nonBlankString,
    asOf: z.iso.datetime({ offset: true }),
    inputs: z.array(turnInputSchema).min(1),
    text: z.string(),
    source: messageSourceSchema,
    messageCount: z.number().int().min(0),
    isPrivate: z.boolean(),
    isGroup: z.boolean(),
    mentionedSelf: z.boolean(),
    repliedToSelf: z.boolean(),
    namedSelf: z.boolean(),
    recentSelfReplies: z.number().int().min(0),
    recentWindowMessages: z.number().int().min(0),
    idleReachedAverage: z.boolean(),
    frequency: z.number().min(0).max(1),
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
    "身份屏障结束后冻结截至指定时刻的输入、来源和时机特征；注意力评估与规划只消费这份可重放上下文。",
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

const heartbeatReasonSchema = z.enum(["message", "wait"]);
const heartbeatPolicyVersionSchema = z.literal("short-heartbeat.v1");
const heartbeatTerminalReference = {
  "core:caused-by": { required: true, multiple: false },
  "core:context": {
    required: false,
    multiple: false,
    targetKinds: ["core.runtime.context"],
  },
  "core:status-of": {
    required: true,
    multiple: false,
    targetKinds: ["agent.heartbeat.scheduled"],
  },
} as const;

export const heartbeatScheduledInformationKind = defineInformationKind({
  kind: "agent.heartbeat.scheduled",
  displayName: "短心跳已调度",
  description:
    "入站聚合或等待请求成功安排调度后记录时间和聚合来源；后续触发或替代终态据此关联同一次心跳。",
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
      asOf: z.iso.datetime({ offset: true }),
    })
    .strict(),
  references: {
    "core:caused-by": { required: true, multiple: false },
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
  displayName: "短心跳已触发",
  description:
    "调度到期且心跳被处理时登记触发结果；心跳模块由此形成可供 Heartflow 认领的回合候选。",
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
  displayName: "短心跳被替代",
  description:
    "新的聚合请求替代已有心跳时登记旧心跳终态；用于追踪防抖替换并避免旧调度重复唤醒。",
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
  displayName: "短心跳失败",
  description:
    "心跳调度或处理失败时保存原因；供维护者关联原调度及可靠执行结果，解释未产生回合候选的原因。",
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

const turnCandidatePayloadSchema = z
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
    asOf: z.iso.datetime({ offset: true }),
    policyVersion: heartbeatPolicyVersionSchema,
    attempt: z.number().int().min(0),
    totalWaitBudget: z.number().int().min(0),
  })
  .strict();

export const turnCandidateInformationKind = defineInformationKind({
  kind: "agent.turn.candidate",
  displayName: "待处理回合候选",
  description:
    "心跳将聚合输入整理为候选时登记来源、范围和等待策略；Heartflow 认领后构造冻结上下文并决定后续动作。",
  payloadSchema: z.union([
    turnCandidatePayloadSchema,
    turnCandidatePayloadSchema.extend({
      managementAuthorizationId: nonBlankString,
    }),
  ]),
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [
        "core.schedule.one-shot.due",
        "agent.message.target.authorized",
      ],
    },
    "agent:heartbeat-fired": {
      required: true,
      multiple: false,
      targetKinds: [heartbeatFiredInformationKind.kind],
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
  displayName: "会话范围实体",
  description:
    "身份归一时建立的平台会话范围，区分规范范围和临时范围；回合隔离与记忆范围选择通过引用复用它。",
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
  displayName: "会话范围绑定",
  description:
    "身份归一时将平台目标绑定到会话实体；后续消息据此解析相同范围并追溯绑定依据。",
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
  displayName: "平台账号实体",
  description:
    "身份归一时为平台、适配器与账号建立实体；人物观察和绑定通过引用关联同一平台账号。",
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
  displayName: "账号人物绑定",
  description:
    "账号被关联到人物实体时记录绑定事实；后续人物解析据此复用人物身份并保留账号来源。",
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
  displayName: "人物实体",
  description:
    "身份归一需要建立人物身份时登记关联账号；人物解析和后续上下文以该实体引用表示人物。",
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
  displayName: "人物资料观察",
  description:
    "处理入站消息时记录账号昵称、群名片和观察时间；下游可追溯当时看到的资料，不将展示名称直接作为稳定身份。",
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
  displayName: "人物身份解析结果",
  description:
    "人物解析完成时记录成功、未解析、歧义、降级或失败及实体引用；下游据此区分身份可用性与平台原始事实。",
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
  displayName: "消息身份上下文就绪",
  description:
    "单条入站消息的身份处理结束后登记状态和实体引用；释放 Heartflow 身份屏障并触发独立原始记忆写回。",
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
