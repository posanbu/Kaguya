/**
 * 功能概述：声明 one-shot scheduler 写入信息 ledger 的五种稳定 information kind。
 * 主要职责：为 requested、due 与 fired/superseded/failed terminal payload 提供严格 JSON schema，
 * 并声明 caused-by、replaces、status-of 引用约束，保证调度事实可追溯且可验证。
 * 代码库关系：Runtime/InformationCore 将这些 definition 注册进 Registry；scheduler client 仅提交数据。
 * 输入输出与副作用：定义创建时同步校验并冻结 metadata；无数据库、timer 或其他 I/O。
 * 展示契约：中文名称与职责说明由定义直接提供给 Inspection 和 WebUI，稳定 kind 与协议字段保持不变。
 */
import { informationIdSchema, z } from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";

const activationSchema = z
  .object({
    instanceId: z.string().trim().min(1),
    definitionId: z.string().trim().min(1),
  })
  .strict();
const opaqueJsonValueSchema: z.ZodTypeAny = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(opaqueJsonValueSchema),
    z.record(z.string(), opaqueJsonValueSchema),
  ]),
);
const opaqueJsonObjectSchema = z.record(z.string(), opaqueJsonValueSchema);
const requestedPayloadSchema = z
  .object({
    operationKey: z.string().trim().min(1),
    dueAt: z.iso.datetime({ offset: true }),
    input: opaqueJsonObjectSchema,
    activation: activationSchema,
  })
  .strict() as z.ZodType<any>;
const duePayloadSchema = z
  .object({
    scheduleInformationId: informationIdSchema,
    dueAt: z.iso.datetime({ offset: true }),
    deliveredAt: z.iso.datetime({ offset: true }),
  })
  .strict();
const terminalReference = {
  "core:status-of": {
    required: true,
    multiple: false,
    targetKinds: ["core.schedule.one-shot.requested"],
  },
} as const;
export const oneShotRequestedInformationKind = defineInformationKind({
  kind: "core.schedule.one-shot.requested",
  displayName: "单次调度请求",
  description:
    "模块提交定时任务时冻结到期时间、输入和激活实例；调度器持久化后负责到期唤醒，并可由后续请求替代。",
  payloadSchema: requestedPayloadSchema,
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:replaces": {
      required: false,
      multiple: false,
      targetKinds: ["core.schedule.one-shot.requested"],
    },
  },
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => ({
      event: "schedule.one-shot.requested",
      dueAt: payload.dueAt,
      activationDefinitionId: payload.activation.definitionId,
      activationInstanceId: payload.activation.instanceId,
    }),
  },
});
export const oneShotDueInformationKind = defineInformationKind({
  kind: "core.schedule.one-shot.due",
  displayName: "单次调度到期",
  description:
    "调度器发现任务到期时记录计划时间和实际交付时间；对应消费者据此处理已持久化输入。",
  payloadSchema: duePayloadSchema,
  references: terminalReference,
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => ({
      event: "schedule.one-shot.due",
      dueAt: payload.dueAt,
      deliveredAt: payload.deliveredAt,
    }),
  },
});
export const oneShotFiredInformationKind = defineInformationKind({
  kind: "core.schedule.one-shot.fired",
  displayName: "单次调度已执行",
  description:
    "到期消费者成功处理后登记调度终态；用于确认请求已执行并防止重复处理。",
  payloadSchema: z.object({}).strict(),
  references: terminalReference,
  log: {
    enabled: true,
    level: "info",
    project: () => ({
      event: "schedule.one-shot.lifecycle",
      status: "fired",
    }),
  },
});
export const oneShotSupersededInformationKind = defineInformationKind({
  kind: "core.schedule.one-shot.superseded",
  displayName: "单次调度被替代",
  description:
    "旧调度被更新请求替换时登记终态；调度器和诊断据此区分取消旧唤醒与处理失败。",
  payloadSchema: z.object({}).strict(),
  references: terminalReference,
  log: {
    enabled: true,
    level: "info",
    project: () => ({
      event: "schedule.one-shot.lifecycle",
      status: "superseded",
    }),
  },
});
export const oneShotFailedInformationKind = defineInformationKind({
  kind: "core.schedule.one-shot.failed",
  displayName: "单次调度失败",
  description:
    "调度输入不可用或消费者处理失败时登记终态及失败类别；下游据此解释定时任务未完成的原因。",
  payloadSchema: z
    .object({ failureKind: z.enum(["consumer-failed", "input-unavailable"]) })
    .strict(),
  references: terminalReference,
  log: {
    enabled: true,
    level: "error",
    project: ({ payload }) => ({
      event: "schedule.one-shot.lifecycle",
      status: "failed",
      failureKind: payload.failureKind,
    }),
  },
});
export const oneShotInformationKinds = [
  oneShotRequestedInformationKind,
  oneShotDueInformationKind,
  oneShotFiredInformationKind,
  oneShotSupersededInformationKind,
  oneShotFailedInformationKind,
] as const;
