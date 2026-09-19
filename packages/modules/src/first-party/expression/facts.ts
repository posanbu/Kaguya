/**
 * 功能概述：表达习惯的受限知识契约，独立于 Persona 与事实 Memory。
 * learningOutputSchema 只允许抽象场景/措辞类别及来源 ID，禁止模型存储人名、账号、私密事实或原文。
 * 学习批次原子落账；habitId 按 scope 与规范模式稳定去重，选择请求冻结候选及计数，选择结果最多三项。
 * 所有定义只描述数据和引用；实际学习、聚合及 Model Task 由 index.ts 负责。
 * expressionLearned / expressionSelected 在 debug 日志中投影已校验的情境、措辞枚举摘要，
 * 不输出原文、来源 ID 或整个 habit 对象；日志投影不改变学习批次和选择结果。
 */
import { createHash } from "node:crypto";
import { z } from "@kaguya/schema";
import { defineInformationKind, defineModuleCapability } from "@kaguya/sdk";
export const situationSchema = z.enum([
  "轻松调侃",
  "表达赞同",
  "表达疑惑",
  "寻求帮助",
  "解释问题",
  "分享喜悦",
  "安慰鼓励",
  "礼貌回应",
  "转换话题",
  "补充信息",
]);
export const styleSchema = z.enum([
  "短句直说",
  "口语化反问",
  "先回应再补充",
  "轻微自嘲",
  "温和保留意见",
  "简短感叹",
  "逐步解释",
  "用类比解释",
  "省略重复主语",
  "克制使用语气词",
  "先共情再建议",
  "简短确认",
]);
const patternSchema = z
  .object({
    situation: situationSchema,
    style: styleSchema,
    sourceInformationIds: z.array(z.string().min(1)).min(1).max(24),
  })
  .strict();
export const learningOutputSchema = z
  .object({ patterns: z.array(patternSchema).max(8) })
  .strict();
export const habitSchema = patternSchema
  .extend({
    habitId: z.string().min(1),
    scopeInformationId: z.string().min(1),
    occurrences: z.number().int().positive(),
    reviewStatus: z.literal("validated"),
    version: z.literal(1),
  })
  .strict();
export type Habit = z.infer<typeof habitSchema>;
export function habitId(scope: string, situation: string, style: string) {
  return createHash("sha256")
    .update(JSON.stringify([scope, situation, style]))
    .digest("hex");
}
const refs = {
  "core:caused-by": { required: true, multiple: false },
  "core:context": { required: false, multiple: false },
  "core:uses-context": { required: true, multiple: true },
} as const;
export const expressionLearningRequested = defineInformationKind({
  kind: "agent.expression.learning.requested",
  displayName: "表达学习请求",
  description: "冻结真实会话、一批真实用户消息和学习版本。",
  payloadSchema: z
    .object({
      scopeInformationId: z.string(),
      sourceInformationIds: z.array(z.string()).min(1).max(24),
      watermark: z.string(),
      version: z.literal(1),
    })
    .strict(),
  references: refs,
  log: { enabled: false },
});
export const expressionLearned = defineInformationKind({
  kind: "agent.expression.learning.completed",
  displayName: "表达学习结果",
  description: "完整验证后一次性保存批次，失败批次不产生可见习惯。",
  payloadSchema: z
    .object({
      scopeInformationId: z.string(),
      status: z.enum(["completed", "rejected", "failed", "cancelled"]),
      reason: z.string(),
      habits: z.array(habitSchema).max(8),
      version: z.literal(1),
    })
    .strict(),
  references: {
    ...refs,
    "core:status-of": { required: true, multiple: false },
  },
  log: {
    enabled: true,
    level: "debug",
    project: ({ payload }) => ({
      event: "expression.learned",
      status: payload.status,
      count: payload.habits.length,
      habitSummaries: payload.habits.map(
        ({ situation, style }) => `${situation} → ${style}`,
      ),
    }),
  },
});
export const expressionSelectionRequested = defineInformationKind({
  kind: "agent.expression.selection.requested",
  displayName: "表达选择请求",
  description: "绑定获胜消息意图及冻结回合、候选与计数。",
  payloadSchema: z
    .object({
      intentInformationId: z.string(),
      scopeInformationId: z.string().nullable(),
      candidates: z.array(habitSchema).max(24),
      version: z.literal(1),
    })
    .strict(),
  references: refs,
  log: { enabled: false },
});
export const selectionOutputSchema = z
  .object({ habitIds: z.array(z.string()).max(3) })
  .strict();
export const expressionSelected = defineInformationKind({
  kind: "agent.expression.selection.completed",
  displayName: "表达选择结果",
  description: "仅提供自然匹配时使用的措辞参考，空集合保持原消息行为。",
  payloadSchema: z
    .object({
      intentInformationId: z.string(),
      scopeInformationId: z.string().nullable(),
      habitIds: z.array(z.string()).max(3),
      habits: z.array(habitSchema).max(3),
      reason: z.string(),
      version: z.literal(1),
    })
    .strict(),
  references: {
    ...refs,
    "core:status-of": { required: true, multiple: false },
  },
  log: {
    enabled: true,
    level: "debug",
    project: ({ payload }) => ({
      event: "expression.selected",
      count: payload.habits.length,
      reason: payload.reason,
      habitSummaries: payload.habits.map(
        ({ situation, style }) => `${situation} → ${style}`,
      ),
    }),
  },
});

export const expressionReady = defineModuleCapability<{ readonly ready: true }>(
  "kaguya:expression.ready",
  1,
);
