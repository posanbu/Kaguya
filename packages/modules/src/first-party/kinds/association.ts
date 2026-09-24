/**
 * 功能概述：association 领域的 Information schema 与不可变定义，独立维护本领域引用和日志投影。
 * 主要职责：下列 schema 校验入账载荷，各 kind 声明因果关系、上下文和诊断元数据；无 I/O。
 * 代码库关系：information-kinds.ts 稳定重导出公共对象；跨领域只复用相邻文件定义，保持 Registry 对象身份。
 * 输入输出与副作用：associationQueryInformationKind 在原有 debug 投影中展示实际 query 的
 * 脱敏限长预览；候选只展示排名和原因，不沿引用加载或复制命中正文，不改变检索行为。
 */
import { platformDestinationSchema, z } from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";
import { contentPreview, nonBlankString } from "./shared.js";
import {
  messageIntentRequestedInformationKind,
  coreMemoryTextInformationKind,
  inboundTextInformationKind,
} from "./message.js";

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
  kind: "memory.association.requested",
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
      targetKinds: ["memory.identity.person.context.completed"],
    },
  },
  log: {
    enabled: true,
    level: "debug",
    project: ({ payload }) => {
      const input = payload as any;
      return {
        event: "memory.association.requested",
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
  kind: "memory.association.query",
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
        event: "memory.association.query",
        route: input.route,
        method: input.method,
        queryLength: Array.from(input.query as string).length,
        limit: input.limit,
        ...contentPreview(input.query),
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
  kind: "memory.association.candidate",
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
      event: "memory.association.candidate",
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
  kind: "memory.association.completed",
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
      event: "memory.association.completed",
      status: payload.status,
      route: payload.route,
      method: payload.method,
      candidateCount: payload.candidateCount,
      reasonCodes: payload.reasonCodes,
    }),
  },
});
