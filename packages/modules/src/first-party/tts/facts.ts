/**
 * 功能概述：声明 TTS 冻结请求、执行标记和唯一结果。
 * 主要职责：事件只保存合成参数、受控资源引用与脱敏错误，不保存凭据或音频字节。
 * 代码库关系：Heavy 发起请求，TTS durable 消费；Runtime 继续负责平台投递。
 * 输入输出与副作用：只定义 schema 和元数据，无网络或文件操作。
 */
import { audioResourceSchema, z } from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";
import { messageTargetSchema, turnProvenanceSchema } from "../kinds/message.js";

export const ttsIdentitySchema = z
  .object({
    provider: z.literal("qwen"),
    accountScope: z.string().min(1),
    region: z.enum(["beijing", "singapore"]),
    model: z.string().min(1),
    voice: z.string().min(1),
    language: z.string().min(1),
  })
  .strict();
export const ttsRequestSchema = z
  .object({
    taskKey: z.string().regex(/^[a-f0-9]{64}$/u),
    assistantInformationId: z.string().min(1),
    text: z.string().min(1).max(1200),
    target: messageTargetSchema,
    turn: turnProvenanceSchema.nullable(),
    identity: ttsIdentitySchema,
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type TtsRequest = z.infer<typeof ttsRequestSchema>;
const contextReference = {
  required: true,
  multiple: false,
  targetKinds: ["core.runtime.context"],
} as const;
const sourceReference = {
  required: true,
  multiple: false,
  targetKinds: ["core.message.assistant.text"],
} as const;
export const ttsRequested = defineInformationKind({
  kind: "agent.tts.requested",
  displayName: "语音合成请求",
  description: "已授权正文的冻结语音参数与目标。",
  payloadSchema: ttsRequestSchema,
  references: {
    "core:context": contextReference,
    "core:caused-by": sourceReference,
    "agent:tts-source": sourceReference,
  },
  log: {
    enabled: true,
    level: "info",
    project: () => ({ event: "tts.requested" }),
  },
});
export const ttsStarted = defineInformationKind({
  kind: "agent.tts.started",
  displayName: "语音合成执行标记",
  description: "外部调用前登记，恢复时不盲目重试未知结果。",
  payloadSchema: z.object({ attempt: z.string().min(1) }).strict(),
  references: {
    "core:context": contextReference,
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [ttsRequested.kind],
    },
  },
  log: {
    enabled: true,
    level: "info",
    project: () => ({ event: "tts.started" }),
  },
});
export const ttsResult = defineInformationKind({
  kind: "agent.tts.result",
  displayName: "语音合成结果",
  description: "完成、失败或取消共用唯一终态槽；完成不等于平台已投递。",
  payloadSchema: z
    .object({
      request: ttsRequestSchema,
      elapsedMs: z.number().finite().nonnegative().default(0),
      inputCharacters: z.int().nonnegative().default(0),
      providerCharacters: z.int().nonnegative().nullable().default(null),
      outcome: z.discriminatedUnion("status", [
        z
          .object({
            status: z.literal("completed"),
            audio: audioResourceSchema,
          })
          .strict(),
        z
          .object({
            status: z.literal("failed"),
            reason: z.enum([
              "synthesis_failed",
              "storage_failed",
              "outcome_unknown",
              "resource_missing",
            ]),
          })
          .strict(),
        z
          .object({
            status: z.literal("cancelled"),
            reason: z.literal("expired_or_cancelled"),
          })
          .strict(),
      ]),
    })
    .strict(),
  references: {
    "core:context": contextReference,
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [ttsRequested.kind],
    },
    "core:status-of": {
      required: true,
      multiple: false,
      targetKinds: [ttsRequested.kind],
    },
    "agent:tts-source": sourceReference,
  },
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => ({
      event: "tts.result",
      status: payload.outcome.status,
      elapsedMs: payload.elapsedMs ?? 0,
      inputCharacters: payload.inputCharacters ?? 0,
      providerCharacters: payload.providerCharacters,
    }),
  },
});

export const ttsDeliveryCancelled = defineInformationKind({
  kind: "agent.tts.delivery.cancelled",
  displayName: "语音投递取消",
  description: "合成结果已过期或取消，关闭回合而不调用平台。",
  payloadSchema: z.object({ request: ttsRequestSchema }).strict(),
  references: {
    "core:context": contextReference,
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [ttsResult.kind],
    },
    "agent:turn-claim": {
      required: false,
      multiple: false,
      targetKinds: ["agent.router.turn.claimed"],
    },
    "agent:turn-candidate": {
      required: false,
      multiple: false,
      targetKinds: ["agent.heartbeat.candidate"],
    },
  },
  log: {
    enabled: true,
    level: "info",
    project: () => ({ event: "tts.delivery.cancelled" }),
  },
});
