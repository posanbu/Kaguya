/**
 * 功能概述：定义 Runtime 自有的 context、通用 Model Task 生命周期和投递结果 kind，并聚合内建 DAG。
 * Model Task：四个 modelTask*InformationKind 保存任务版本、选择策略、模型、激活来源与 Prompt
 * provenance；终态使用同一 requested 的 status-of，输出仅为 JSON，具体 schema 由调用方拥有。
 * modelTaskInformationKinds 提供独立注册集合；日志仅投影固定事件、状态及耗时，不包含业务正文。
 * 主要职责：Runtime definition 约束严格 payload、直接 caused-by/status-of/context 与
 * requested uses-context 引用及脱敏日志投影；`builtInInformationKinds` 原样复用 Engine
 * 与 modules 的 definitions，保证每个字面 kind 只存在一个对象定义。
 * 代码库关系：`runtime.ts` 用聚合集合初始化 Registry；`model-task.ts` 写通用模型任务原子；系统
 * delivery consumer 写 delivered/failed 原子；业务模块接收同一 completed definition 实例。
 * 输入输出与副作用：所有导出都是无 I/O 的 schema/definition/tuple。requested prompt 会把
 * fragment metadata 规范为 JSON；projector 不输出 prompt/output/raw 或凭据。
 */
import { consumerFailedInformationKind } from "@kaguya/engine";
import {
  deliveryRequestedInformationKind,
  informationModuleKinds,
} from "@kaguya/modules";
import {
  type CompiledPrompt,
  type InformationId,
  type JsonObject,
  type PromptFragmentSource,
  compiledPromptSchema,
  jsonValueSchema,
  informationIdSchema,
  informationPayloadSchema,
  platformDestinationSchema,
  promptKindSchema,
  z,
} from "@kaguya/schema";
import {
  defineInformationKind,
  type InformationKindDefinition,
} from "@kaguya/sdk";

const nonBlankString = z.string().trim().min(1);
type InformationPromptFragment = JsonObject & {
  id: string;
  informationId?: InformationId;
  source: PromptFragmentSource;
  priority: number;
  content: string;
  metadata: JsonObject;
};
type InformationPromptProvenance = JsonObject & {
  fragmentId: string;
  informationId?: InformationId;
  source: PromptFragmentSource;
  priority: number;
  contentDigest: string;
};
export type InformationCompiledPrompt = JsonObject & {
  kind: CompiledPrompt["kind"];
  text: string;
  fragments: InformationPromptFragment[];
  provenance: InformationPromptProvenance[];
};

export const informationCompiledPromptSchema =
  compiledPromptSchema.transform<InformationCompiledPrompt>(
    (prompt, context) => {
      const fragments: InformationPromptFragment[] = prompt.fragments.map(
        (fragment, index) => {
          const metadata = informationPayloadSchema.safeParse(
            fragment.metadata,
          );
          if (!metadata.success) {
            for (const issue of metadata.error.issues) {
              context.addIssue({
                ...issue,
                path: ["fragments", index, "metadata", ...issue.path],
              });
            }
            return {
              id: fragment.id,
              ...(fragment.informationId === undefined
                ? {}
                : { informationId: fragment.informationId }),
              source: fragment.source,
              priority: fragment.priority,
              content: fragment.content,
              metadata: {},
            } as InformationPromptFragment;
          }
          return {
            id: fragment.id,
            ...(fragment.informationId === undefined
              ? {}
              : { informationId: fragment.informationId }),
            source: fragment.source,
            priority: fragment.priority,
            content: fragment.content,
            metadata: metadata.data,
          } as InformationPromptFragment;
        },
      );
      const provenance: InformationPromptProvenance[] = prompt.provenance.map(
        (entry) =>
          ({
            fragmentId: entry.fragmentId,
            ...(entry.informationId === undefined
              ? {}
              : { informationId: entry.informationId }),
            source: entry.source,
            priority: entry.priority,
            contentDigest: entry.contentDigest,
          }) as InformationPromptProvenance,
      );
      return {
        kind: prompt.kind,
        text: prompt.text,
        fragments,
        provenance,
      } as InformationCompiledPrompt;
    },
  );
const contextReference = {
  required: true,
  multiple: false,
  targetKinds: ["core.runtime.context"],
} as const;

export const runtimeContextInformationKind = defineInformationKind({
  kind: "core.runtime.context",
  payloadSchema: z.object({}).strict(),
  references: {},
  log: { enabled: false },
});

const safeDeliveryBaseShape = {
  ok: z.boolean(),
  adapterId: nonBlankString,
  platform: nonBlankString,
  target: platformDestinationSchema,
};

export const deliveryDeliveredInformationKind = defineInformationKind({
  kind: "core.delivery.delivered",
  payloadSchema: z.union([
    z
      .object({
        ...safeDeliveryBaseShape,
        ok: z.literal(true),
        platformMessageId: nonBlankString,
      })
      .strict(),
    z
      .object({
        ...safeDeliveryBaseShape,
        ok: z.literal(true),
      })
      .strict(),
  ]),
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [deliveryRequestedInformationKind.kind],
    },
    "core:status-of": {
      required: true,
      multiple: false,
      targetKinds: [deliveryRequestedInformationKind.kind],
    },
    "core:context": contextReference,
  },
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => ({
      event: "delivery.lifecycle",
      status: "delivered",
      adapterId: payload.adapterId,
      platform: payload.platform,
      ...("platformMessageId" in payload
        ? { platformMessageId: payload.platformMessageId }
        : {}),
    }),
  },
});

export const deliveryFailedInformationKind = defineInformationKind({
  kind: "core.delivery.failed",
  payloadSchema: z
    .object({
      ...safeDeliveryBaseShape,
      ok: z.literal(false),
      error: nonBlankString,
    })
    .strict(),
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [deliveryRequestedInformationKind.kind],
    },
    "core:status-of": {
      required: true,
      multiple: false,
      targetKinds: [deliveryRequestedInformationKind.kind],
    },
    "core:context": contextReference,
  },
  log: {
    enabled: true,
    level: "warn",
    project: ({ payload }) => ({
      event: "delivery.lifecycle",
      status: "failed",
      adapterId: payload.adapterId,
      platform: payload.platform,
      errorType: payload.error,
    }),
  },
});

export const modelTaskSelectionPolicySchema = z
  .object({
    tier: z.enum(["light", "heavy"]),
  })
  .strict();
export const modelTaskResolvedModelSchema = z
  .object({
    providerId: nonBlankString,
    modelId: nonBlankString,
  })
  .strict();
const modelTaskProvenanceBase = compiledPromptSchema.shape.provenance.element
  .omit({ informationId: true })
  .strict();
const modelTaskProvenanceSchema = z.array(
  z.union([
    modelTaskProvenanceBase
      .extend({ informationId: informationIdSchema })
      .strict(),
    modelTaskProvenanceBase,
  ]),
);
export const modelTaskMetadataSchema = z
  .object({
    taskId: nonBlankString,
    version: nonBlankString,
    sourceInformationId: informationIdSchema,
    contextInformationId: informationIdSchema,
    contextInformationIds: z.array(informationIdSchema).min(1),
    promptKind: promptKindSchema,
    provenance: modelTaskProvenanceSchema,
    activation: z
      .object({ instanceId: nonBlankString, definitionId: nonBlankString })
      .strict(),
    selectionPolicy: modelTaskSelectionPolicySchema,
    resolvedModel: modelTaskResolvedModelSchema,
  })
  .strict();
const modelTaskTerminalReferences = {
  "core:caused-by": {
    required: true,
    multiple: false,
    targetKinds: ["core.model.task.requested"],
  },
  "core:status-of": {
    required: true,
    multiple: false,
    targetKinds: ["core.model.task.requested"],
  },
  "core:context": contextReference,
} as const;
const modelTaskTerminalShape = {
  ...modelTaskMetadataSchema.shape,
  durationMs: z.number().nonnegative(),
};
const modelTaskUsageShape = {
  usage: z.record(z.string(), z.number().nonnegative()),
};
// SDK 的 schema 检查需要可构造的输入样本；null 分支提供样本，最终 pipe 仍严格拒绝非 JSON。
const modelTaskOutputSchema = z
  .union([z.null(), z.unknown()])
  .pipe(jsonValueSchema);
export const modelTaskSafeErrorSchema = z
  .object({
    name: z.literal("ModelTaskError"),
    kind: z.enum(["retryable", "non-retryable"]),
    message: z.literal("Model task generation failed"),
  })
  .strict();
export const modelTaskRequestedInformationKind = defineInformationKind({
  kind: "core.model.task.requested",
  payloadSchema: modelTaskMetadataSchema
    .extend({ prompt: informationCompiledPromptSchema })
    .strict(),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": contextReference,
    "core:uses-context": { required: true, multiple: true },
  },
  log: {
    enabled: true,
    level: "info",
    project: () => ({ event: "model.task.lifecycle", status: "requested" }),
  },
});
export const modelTaskCompletedInformationKind = defineInformationKind({
  kind: "core.model.task.completed",
  payloadSchema: z.union([
    z
      .object({
        ...modelTaskTerminalShape,
        ...modelTaskUsageShape,
        output: modelTaskOutputSchema,
      })
      .strict(),
    z
      .object({ ...modelTaskTerminalShape, output: modelTaskOutputSchema })
      .strict(),
  ]),
  references: modelTaskTerminalReferences,
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => ({
      event: "model.task.lifecycle",
      status: "completed",
      durationMs: payload.durationMs,
    }),
  },
});
export const modelTaskFailedInformationKind = defineInformationKind({
  kind: "core.model.task.failed",
  payloadSchema: z.union([
    z
      .object({
        ...modelTaskTerminalShape,
        ...modelTaskUsageShape,
        error: modelTaskSafeErrorSchema,
      })
      .strict(),
    z
      .object({ ...modelTaskTerminalShape, error: modelTaskSafeErrorSchema })
      .strict(),
  ]),
  references: modelTaskTerminalReferences,
  log: {
    enabled: true,
    level: "error",
    project: () => ({ event: "model.task.lifecycle", status: "failed" }),
  },
});
export const modelTaskCancelledInformationKind = defineInformationKind({
  kind: "core.model.task.cancelled",
  payloadSchema: z
    .object({
      ...modelTaskTerminalShape,
      reason: z.literal("Explicit cancellation requested"),
    })
    .strict(),
  references: modelTaskTerminalReferences,
  log: {
    enabled: true,
    level: "info",
    project: () => ({ event: "model.task.lifecycle", status: "cancelled" }),
  },
});
export const modelTaskInformationKinds = Object.freeze([
  modelTaskRequestedInformationKind,
  modelTaskCompletedInformationKind,
  modelTaskFailedInformationKind,
  modelTaskCancelledInformationKind,
] as const);

export const builtInInformationKinds = Object.freeze([
  runtimeContextInformationKind,
  consumerFailedInformationKind,
  ...informationModuleKinds,
  deliveryDeliveredInformationKind,
  deliveryFailedInformationKind,
] as const satisfies readonly InformationKindDefinition<string, any>[]);
