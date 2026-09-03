/**
 * 功能概述：本文件声明 modules 包拥有的消息 DAG kind，明确区分入站、过滤通过后的
 * 回复请求、过滤拒绝、assistant 文本和平台投递请求，替代旧事件与定向回复语义。
 * 主要职责：每个 definition 固定 payload 的严格 schema 和直接因果/context 引用规则；
 * `informationModuleKinds` 供 Runtime 在启动 Core 前一次注册同一批 definition。
 * 代码库关系：始终回复过滤器消费入站并产生回复请求；LLM 回复模块消费回复请求、外部
 * 注入的 LLM completed definition 与 assistant，随后产生后续 kind；Runtime 负责 LLM
 * 生命周期和投递结果 kind，不能重新定义本文件已经拥有的 literal kind。
 * 输入输出与副作用：所有导出都是冻结的纯定义，无 I/O；payload 和引用在 Core 注册前
 * 受校验，模块宿主会自动补齐 `core:caused-by` 与继承的 `core:context`。
 */
import {
  outboundMessageContentSchema,
  platformDestinationSchema,
  z,
} from "@kaguya/schema";
import { defineInformationKind, type InformationKindDefinition } from "@kaguya/sdk";

const nonBlankString = z.string().trim().min(1);

const messageSourceSchema = z
  .object({
    adapterId: nonBlankString,
    platform: nonBlankString,
    platformMessageId: nonBlankString,
    destination: platformDestinationSchema,
    senderId: nonBlankString,
  })
  .strict();

export const replyRequestedInformationPayloadSchema = z
  .object({
    text: z.string(),
    source: messageSourceSchema,
  })
  .strict();
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
  log: { enabled: false },
});

export const replyRequestedInformationKind = defineInformationKind({
  kind: "core.reply.requested",
  payloadSchema: replyRequestedInformationPayloadSchema,
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
  log: { enabled: false },
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
  log: { enabled: false },
});

export const assistantTextInformationKind = defineInformationKind({
  kind: "core.message.assistant.text",
  payloadSchema: z
    .object({ text: z.string(), source: messageSourceSchema })
    .strict(),
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: ["core.llm.completed"],
    },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
  },
  log: { enabled: false },
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
  log: { enabled: false },
});

export const informationModuleKinds = [
  inboundTextInformationKind,
  replyRequestedInformationKind,
  filterDecisionInformationKind,
  assistantTextInformationKind,
  deliveryRequestedInformationKind,
] as const satisfies readonly InformationKindDefinition<string, any>[];
