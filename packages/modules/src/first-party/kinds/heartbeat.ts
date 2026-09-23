/**
 * 功能概述：heartbeat 领域的 Information schema 与不可变定义，独立维护本领域引用和日志投影。
 * 主要职责：下列 schema 校验入账载荷，各 kind 声明因果关系、上下文和诊断元数据；无 I/O。
 * 代码库关系：information-kinds.ts 稳定重导出公共对象；跨领域只复用相邻文件定义，保持 Registry 对象身份。
 */
import { platformDestinationSchema, z } from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";
import { nonBlankString } from "./shared.js";
import { inboundTextInformationKind } from "./message.js";

const heartbeatReasonSchema = z.enum([
  "message",
  "wait",
  "interrupt",
  "recheck",
]);

const heartbeatPolicyVersionSchema = z.literal("short-heartbeat.v1");
const attentionOpportunityPolicyVersionSchema = z.literal(
  "attention-opportunity.v1",
);

export const attentionArousalActivityInformationKind = defineInformationKind({
  kind: "agent.attention.arousal.activity",
  displayName: "全局消息活动",
  description:
    "Heartbeat 将入站注册投影为不含正文的全局活动事实；Arousal 用它直接重置休眠 deadline。",
  payloadSchema: z
    .object({
      inboundInformationId: nonBlankString,
      observedAt: z.iso.datetime({ offset: true }),
      policyVersion: z.literal("attention-activity.v1"),
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
    level: "debug",
    project: ({ payload }) => ({
      event: "attention.arousal.activity",
      observedAt: payload.observedAt,
    }),
  },
});

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

const heartbeatScheduledPayloadSchema = z
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
    rebuildAttempt: z.number().int().min(0).default(0),
    totalWaitBudget: z.number().int().min(0),
    scopeKey: nonBlankString,
    asOf: z.iso.datetime({ offset: true }),
  })
  .strict() as any;

export const heartbeatScheduledInformationKind = defineInformationKind({
  kind: "agent.heartbeat.scheduled",
  displayName: "短心跳已调度",
  description:
    "入站聚合或等待请求成功安排调度后记录时间和聚合来源；后续触发或替代终态据此关联同一次心跳。",
  payloadSchema: z.union([
    heartbeatScheduledPayloadSchema,
    heartbeatScheduledPayloadSchema.extend({
      predecessorCandidateInformationId: nonBlankString,
    }),
  ]),
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
    "新的等待或打断请求替代已有心跳时登记旧心跳终态；用于追踪延迟替换并避免旧调度重复唤醒。",
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
    triggerInformationId: nonBlankString,
    reason: heartbeatReasonSchema,
    dueAt: z.iso.datetime({ offset: true }),
    firedAt: z.iso.datetime({ offset: true }),
    platform: nonBlankString,
    adapterId: nonBlankString,
    destination: platformDestinationSchema,
    unreadAfterInformationId: nonBlankString.optional(),
    unreadThroughInformationId: nonBlankString,
    unreadCount: z.number().int().min(1).max(1000),
    signals: z
      .array(
        z.enum([
          "private",
          "web",
          "mention-self",
          "mention-all",
          "reply-self",
          "passive",
          "recheck",
        ]),
      )
      .min(1),
    scopeKey: nonBlankString,
    asOf: z.iso.datetime({ offset: true }),
    policyVersion: attentionOpportunityPolicyVersionSchema,
    rebuildAttempt: z.number().int().min(0).default(0),
    attempt: z.number().int().min(0),
    totalWaitBudget: z.number().int().min(0),
  })
  .strict() as any;

export const turnCandidateInformationKind = defineInformationKind({
  kind: "agent.turn.candidate",
  displayName: "注意力观察机会",
  description:
    "入站通知或延迟调度登记不含正文的观察机会，只保存范围、触发事实、未读注册水位、数量与平台信号；Arousal 决定 observe 后 Heartflow 才能查询正文。",
  payloadSchema: z.union([
    turnCandidatePayloadSchema,
    turnCandidatePayloadSchema.extend({
      managementAuthorizationId: nonBlankString,
    }),
  ]),
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
      event: "turn.candidate",
      reason: payload.reason,
      dueAt: payload.dueAt,
      firedAt: payload.firedAt,
      unreadCount: payload.unreadCount,
      signals: payload.signals,
    }),
  },
});

export const observationWakeInformationKind = defineInformationKind({
  kind: "agent.observation.wake",
  displayName: "开放观察唤醒",
  description: "提升同 scope 的唯一观察或恢复遗留积压，不创建消息回合队列。",
  payloadSchema: z
    .object({ scopeKey: nonBlankString, immediate: z.boolean() })
    .strict(),
  references: {
    "core:uses-context": {
      required: true,
      multiple: true,
      targetKinds: [inboundTextInformationKind.kind],
    },
    "core:caused-by": { required: true, multiple: false },
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
    level: "debug",
    project: ({ payload }) => ({
      event: "observation.wake",
      immediate: payload.immediate,
    }),
  },
});
