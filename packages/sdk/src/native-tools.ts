/**
 * 模型绑定缺失与变化有独立停止原因；旧 run 保持终态而不重新派发。
 * 功能概述：定义原生工具循环的持久事实和有界预算，LLM 与外部行动各自保存真实结果。
 * run 固定宿主配置；step 保存后继冻结知识；result 保存 call/receipt 配对；terminal 表示停止推进。
 * Runtime 写入，database 从 step 与真实模型请求重验补充依据；声明不执行工具或授予权限。
 */
import { z, jsonValueSchema, nativeMemorySnapshotSchema } from "@kaguya/schema";
import { defineInformationKind } from "./information-kind.js";

const id = z.string().min(1).max(1000);
export const nativeToolBudgetSchema = z
  .object({
    maxSteps: z.number().int().min(1).max(32).default(8),
    maxCalls: z.number().int().min(1).max(128).default(16),
    maxDurationMs: z.number().int().min(1).max(3600000).default(300000),
    maxContextBytes: z.number().int().min(256).max(1048576).default(128000),
    maxOutputBytes: z.number().int().min(256).max(1048576).default(128000),
    maxToolOutputBytes: z.number().int().min(256).max(1048576).default(64000),
    maxTotalToolOutputBytes: z
      .number()
      .int()
      .min(256)
      .max(4194304)
      .default(256000),
    parallelism: z.number().int().min(1).max(8).default(2),
  })
  .strict();
export type NativeToolBudget = z.infer<typeof nativeToolBudgetSchema>;
const refs = {
  "core:uses-context": { required: true, multiple: true },
  "core:context": { required: true, multiple: false },
} as const;
export const nativeToolRunInformationKind = defineInformationKind({
  kind: "agent.heavy.tool.run.v1",
  displayName: "工具循环",
  description: "宿主冻结任务、工具目录和预算；模型不修改执行策略。",
  payloadSchema: z
    .object({ key: id, spec: z.record(z.string(), z.json()) })
    .strict(),
  references: refs,
  log: { enabled: false },
});
export const nativeToolStepSchema = z
  .object({
    runInformationId: id,
    observationId: id,
    stepIndex: z.number().int().nonnegative(),
    previousStepInformationId: id.nullable(),
    modelCompletedInformationId: id.nullable(),
    receiptIds: z.array(id).max(128),
    memory: nativeMemorySnapshotSchema.nullable(),
    // 历史 Memory 阅读可以显示较老修订；补充快照逐一保存真实展示内容及其上界。
    supplements: z.array(nativeMemorySnapshotSchema).max(128),
  })
  .strict();
export const nativeToolStepInformationKind = defineInformationKind({
  kind: "agent.heavy.tool.step.frozen.v1",
  displayName: "工具后继冻结步骤",
  description: "关联实际模型调用及回执，保存该步骤使用的 Memory 与来源上界。",
  payloadSchema: nativeToolStepSchema
    .omit({ memory: true, supplements: true })
    .extend({
      memory: z.record(z.string(), z.json()).nullable(),
      supplements: z.array(z.record(z.string(), z.json())),
    })
    .strict(),
  references: refs,
  log: { enabled: false },
});
export const nativeToolResultInformationKind = defineInformationKind({
  kind: "agent.heavy.tool.result.v1",
  displayName: "原生工具结果配对",
  description: "把模型 call ID 与真实行动回执或持久校验拒绝配对。",
  payloadSchema: z
    .object({
      runInformationId: id,
      stepIndex: z.number().int().nonnegative(),
      toolCallId: id,
      modelCompletedInformationId: id,
      intentId: id.nullable(),
      receiptId: id.nullable(),
      value: z.union([z.null(), z.unknown()]).pipe(jsonValueSchema),
      outputBytes: z.number().int().nonnegative(),
    })
    .strict(),
  references: refs,
  log: { enabled: false },
});
export const nativeToolTerminalInformationKind = defineInformationKind({
  kind: "agent.heavy.tool.terminal.v1",
  displayName: "工具循环停止",
  description: "保留最终模型结果或停止原因；停止推进不表示外部行动已取消。",
  payloadSchema: z
    .object({
      runInformationId: id,
      reason: z.enum([
        "final",
        "model-failed",
        "model-outcome-unknown",
        "cancelled",
        "superseded",
        "budget",
        "unknown",
        "partial",
        "unavailable",
        "native-model-binding-missing",
        "native-model-binding-changed",
        "protocol",
      ]),
      modelResult: z.record(z.string(), z.json()).nullable(),
    })
    .strict(),
  references: refs,
  log: { enabled: false },
});
export const nativeToolOriginCancelledInformationKind = defineInformationKind({
  kind: "agent.heavy.tool.origin.cancelled.v1",
  displayName: "工具任务原点取消",
  description:
    "在 run 创建或模型派发之前持久取消宿主任务原点，不宣称外部效果已撤回。",
  payloadSchema: z.object({ originKey: id }).strict(),
  references: refs,
  log: { enabled: false },
});
export const nativeToolCancellationForwardedInformationKind =
  defineInformationKind({
    kind: "agent.heavy.tool.cancel.forwarded.v1",
    displayName: "工具取消已转发",
    description: "下游取消请求已完成转发；这不证明外部物理效果被撤回。",
    payloadSchema: z.object({ originKey: id }).strict(),
    references: refs,
    log: { enabled: false },
  });
export const nativeToolInformationKinds = [
  nativeToolOriginCancelledInformationKind,
  nativeToolCancellationForwardedInformationKind,
  nativeToolRunInformationKind,
  nativeToolStepInformationKind,
  nativeToolResultInformationKind,
  nativeToolTerminalInformationKind,
] as const;
