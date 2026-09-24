/**
 * 功能概述：QQ 表情插件独占的收藏、语义推断与选择契约。
 * collected 持久化可重发素材及冻结来源；learned 仅表示上下文推断，未知不参与候选。
 * selectionRequested 冻结草稿、候选 ID 与输入；不把二进制或远程地址发送给模型。
 * 所有事实沿 Core 引用去重与审计，不依赖 Persona、Memory 或其他学习模块。
 */
import { z, outboundExpressionSchema } from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";
const refs = {
  "core:caused-by": { required: true, multiple: false },
  "core:context": {
    required: true,
    multiple: false,
    targetKinds: ["core.runtime.context"],
  },
  "core:uses-context": { required: true, multiple: true },
} as const;
export const collected = defineInformationKind({
  kind: "plugin.qq-expression.collected",
  displayName: "收藏的 QQ 表情",
  description: "按会话保存可重发素材和上下文，不读取图像内容。",
  payloadSchema: z
    .object({
      scope: z.string(),
      assetId: z.string(),
      expression: outboundExpressionSchema,
      sourceInformationId: z.string(),
    })
    .strict(),
  references: refs,
  log: { enabled: false },
});
export const observed = defineInformationKind({
  kind: "plugin.qq-expression.observed",
  displayName: "表情用法观测",
  description: "已有素材的新使用上下文；允许后续证据修正早期未知推断。",
  payloadSchema: z
    .object({
      scope: z.string(),
      assetInformationId: z.string(),
      sourceInformationId: z.string(),
    })
    .strict(),
  references: refs,
  log: { enabled: false },
});
export const meaningSchema = z
  .object({
    meaning: z.string().max(160),
    usage: z.string().max(160),
    confidence: z.number().min(0).max(1),
    evidenceIds: z.array(z.string()).max(9),
  })
  .strict();
export const learned = defineInformationKind({
  kind: "plugin.qq-expression.learned",
  displayName: "表情语义推断",
  description: "有聊天来源的语义及用法推断，不代表视觉识别或确定事实。",
  payloadSchema: meaningSchema
    .extend({
      scope: z.string(),
      assetInformationId: z.string(),
      basis: z.literal("context-inference"),
    })
    .strict(),
  references: refs,
  log: {
    enabled: true,
    level: "debug",
    project: ({ payload }) => ({
      event: "qq-expression.learned",
      confidence: payload.confidence,
    }),
  },
});
export const selectionRequested = defineInformationKind({
  kind: "plugin.qq-expression.selection.requested",
  displayName: "表情选择请求",
  description: "冻结同会话的候选与当前草稿，最终仍需通过发送限额。",
  payloadSchema: z
    .object({
      draftInformationId: z.string(),
      scope: z.string(),
      candidateIds: z.array(z.string()).max(24),
    })
    .strict(),
  references: refs,
  log: { enabled: false },
});
export const selectionSchema = z
  .object({
    assetInformationId: z.string().nullable(),
    emoji: z.string().max(32).nullable(),
  })
  .strict();
export const settingsSchema = z
  .object({
    cooldownSeconds: z
      .number()
      .int()
      .min(60)
      .max(86400)
      .default(600)
      .meta({ title: "表情冷却秒数", public: true, default: 600 }),
    minMessagesBetween: z
      .number()
      .int()
      .min(3)
      .max(100)
      .default(8)
      .meta({ title: "两次表情间的普通回复数", public: true, default: 8 }),
    minConfidence: z
      .number()
      .min(0.7)
      .max(1)
      .default(0.85)
      .meta({ title: "语义推断最低置信度", public: true, default: 0.85 }),
    maxAssetsPerScope: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(100)
      .meta({ title: "每个会话最多收藏数", public: true, default: 100 }),
  })
  .strict();
