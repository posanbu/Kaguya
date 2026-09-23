/**
 * 功能概述：message 领域的 Information schema 与不可变定义，独立维护本领域引用和日志投影。
 * 主要职责：下列 schema 校验入账载荷，各 kind 声明因果关系、上下文和诊断元数据；无 I/O。
 * 代码库关系：information-kinds.ts 稳定重导出公共对象；跨领域只复用相邻文件定义，保持 Registry 对象身份。
 * 输入输出与副作用：消息和记忆正文仅经 shared.contentPreview 生成脱敏、限长的日志字段；
 * coreMemoryTextInformationKind 的正文仍只在原有 debug 等级投影，不改变记忆载荷或写回流程。
 */
import {
  outboundMessageContentSchema,
  platformDestinationSchema,
  z,
} from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";
import {
  nonBlankString,
  messageSourceSchema,
  contentPreview,
} from "./shared.js";

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

const focusInformationIdsSchema = z
  .array(nonBlankString)
  .min(1)
  .max(3)
  .superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: "custom",
        message: "Composition focusInformationIds must be unique",
      });
  });

const messageCompositionShape = {
  focusInformationIds: focusInformationIdsSchema,
  topic: z.string().trim().min(1).max(200),
  replyAct: z.string().trim().min(1).max(120),
};
export const messageCompositionSchema = z.union([
  z.object(messageCompositionShape).strict(),
  z
    .object({
      ...messageCompositionShape,
      guidance: z.string().trim().min(1).max(500),
    })
    .strict(),
]);

export const inboundTextInformationPayloadSchema = z
  .object({ text: z.string(), source: messageSourceSchema })
  .strict();

export const messageIntentRequestedInformationPayloadSchema = z
  .object({
    target: messageTargetSchema,
    turn: turnProvenanceSchema,
    memoryInformationIds: z.array(nonBlankString),
    composition: messageCompositionSchema,
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
    project: ({ payload }) => ({
      event: "memory.text.registered",
      ...contentPreview(payload.text),
    }),
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
