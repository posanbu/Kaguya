/**
 * 功能概述：定义 Runtime 自有的 context、通用 Model Task 生命周期和投递结果 kind，并聚合内建 DAG。
 * Model Task：四个 modelTask*InformationKind 保存任务版本、选择策略、模型、激活来源与 Prompt
 * provenance；终态使用同一 requested 的 status-of，输出仅为 JSON，具体 schema 由调用方拥有。
 * modelTaskInformationKinds 提供独立注册集合；日志默认投影摘要与 Prompt 预览，debug detail
 * 才投影经凭据清理的完整 Prompt 和 provenance，不包含模型输出或 provider 原始响应。
 * 主要职责：Runtime definition 约束严格 payload、直接 caused-by/status-of/context 与
 * requested uses-context 引用及脱敏日志投影；`builtInInformationKinds` 原样复用 Engine
 * 与 modules 的 definitions，保证每个字面 kind 只存在一个对象定义。
 * 代码库关系：`runtime.ts` 用聚合集合初始化 Registry；`model-task.ts` 写通用模型任务原子；系统
 * delivery consumer 写 delivered/failed 原子；业务模块接收同一 completed definition 实例。
 * 输入输出与副作用：所有导出都是无 I/O 的 schema/definition/tuple。requested prompt 会把
 * variable provenance 规范为 JSON；projector 不输出 prompt/output/raw 或凭据。
 */
import { createHash } from "node:crypto";

import { consumerFailedInformationKind } from "@kaguya/engine";
import { previewInformationContent } from "@kaguya/logger";
import {
  deliveryRequestedInformationKind,
  inboundTextInformationKind,
} from "@kaguya/modules";
import {
  type CompiledPrompt,
  type InformationId,
  type JsonObject,
  compiledPromptSchema,
  jsonValueSchema,
  informationIdSchema,
  platformDestinationSchema,
  promptKindSchema,
  z,
} from "@kaguya/schema";
import {
  defineInformationKind,
  type InformationKindDefinition,
} from "@kaguya/sdk";

const nonBlankString = z.string().trim().min(1);
type InformationPromptVariable = JsonObject & {
  name: string;
  content: string;
  informationIds: InformationId[];
};
type InformationPromptProvenance = JsonObject & {
  variableName: string;
  informationIds: InformationId[];
  contentDigest: string;
};
export type InformationCompiledPrompt = JsonObject & {
  kind: CompiledPrompt["kind"];
  text: string;
  templateId: string;
  templates: Array<JsonObject & { name: string; content: string }>;
  templateDigest: string;
  promptDigest: string;
  variables: InformationPromptVariable[];
  provenance: InformationPromptProvenance[];
};

export const informationCompiledPromptSchema =
  compiledPromptSchema.transform<InformationCompiledPrompt>(
    (prompt, context) => {
      void context;
      const variables: InformationPromptVariable[] = prompt.variables.map(
        (variable) => ({
          name: variable.name,
          content: variable.content,
          informationIds: [...variable.informationIds],
        }),
      );
      const provenance: InformationPromptProvenance[] = variables.map(
        (variable) => ({
          variableName: variable.name,
          informationIds: [...variable.informationIds],
          contentDigest: digest(variable.content),
        }),
      );
      return {
        kind: prompt.kind,
        text: prompt.text,
        templateId: prompt.templateId,
        templates: prompt.templates.map((template) => ({ ...template })),
        templateDigest: digest(JSON.stringify(prompt.templates)),
        promptDigest: digest(prompt.text),
        variables,
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
  displayName: "Core Runtime Context",
  description: "Information carried by the core.runtime.context kind.",
  payloadSchema: z.object({}).strict(),
  references: {},
  log: {
    enabled: true,
    level: "info",
    project: () => ({ event: "runtime.context" }),
  },
});

const safeDeliveryBaseShape = {
  ok: z.boolean(),
  adapterId: nonBlankString,
  platform: nonBlankString,
  target: platformDestinationSchema,
};

export const deliveryDeliveredInformationKind = defineInformationKind({
  kind: "core.delivery.delivered",
  displayName: "Core Delivery Delivered",
  description: "Information carried by the core.delivery.delivered kind.",
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
  displayName: "Core Delivery Failed",
  description: "Information carried by the core.delivery.failed kind.",
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
export const modelTaskOutputModeSchema = z.enum(["text", "object"]);
export const modelTaskResolvedModelSchema = z
  .object({
    providerId: nonBlankString,
    modelId: nonBlankString,
  })
  .strict();
const modelTaskProvenanceSchema = z.array(
  z
    .object({
      variableName: nonBlankString,
      informationIds: z.array(informationIdSchema),
      contentDigest: nonBlankString,
    })
    .strict(),
);
export const modelTaskMetadataSchema = z
  .object({
    taskId: nonBlankString,
    version: nonBlankString,
    outputMode: modelTaskOutputModeSchema,
    sourceInformationId: informationIdSchema,
    contextInformationId: informationIdSchema,
    contextInformationIds: z.array(informationIdSchema).min(1),
    promptKind: promptKindSchema,
    promptTemplateId: nonBlankString,
    promptTemplateDigest: nonBlankString,
    promptDigest: nonBlankString,
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
    stage: z.enum([
      "provider-request",
      "structured-output-parse",
      "task-schema-validation",
    ]),
    message: z.literal("Model task generation failed"),
  })
  .strict();
export const modelTaskRequestedInformationKind = defineInformationKind({
  kind: "core.model.task.requested",
  displayName: "Core Model Task Requested",
  description: "Information carried by the core.model.task.requested kind.",
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
    project: ({ payload }) => ({
      event: "model.task.lifecycle",
      status: "requested",
      taskId: payload.taskId,
      taskVersion: payload.version,
      activationDefinitionId: payload.activation.definitionId,
      activationInstanceId: payload.activation.instanceId,
      tier: payload.selectionPolicy.tier,
      providerId: payload.resolvedModel.providerId,
      modelId: payload.resolvedModel.modelId,
      outputMode: payload.outputMode,
      promptCharacters: Array.from(payload.prompt.text).length,
      promptVariableCount: payload.prompt.variables.length,
      ...promptPreview(payload.prompt.text),
    }),
    detail: {
      sensitivity: "content",
      project: ({ payload }) => ({
        event: "model.task.prompt",
        status: "requested",
        taskId: payload.taskId,
        taskVersion: payload.version,
        promptFull: sanitizePromptForLogging(payload.prompt.text),
        promptVariables: payload.prompt.provenance.map((entry) => ({
          variableName: entry.variableName,
          informationIds: entry.informationIds,
          contentDigest: entry.contentDigest,
        })),
      }),
    },
  },
});

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
export const modelTaskCompletedInformationKind = defineInformationKind({
  kind: "core.model.task.completed",
  displayName: "Core Model Task Completed",
  description: "Information carried by the core.model.task.completed kind.",
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
      taskId: payload.taskId,
      taskVersion: payload.version,
      activationDefinitionId: payload.activation.definitionId,
      activationInstanceId: payload.activation.instanceId,
      tier: payload.selectionPolicy.tier,
      providerId: payload.resolvedModel.providerId,
      modelId: payload.resolvedModel.modelId,
      outputMode: payload.outputMode,
      durationMs: payload.durationMs,
    }),
  },
});
export const modelTaskFailedInformationKind = defineInformationKind({
  kind: "core.model.task.failed",
  displayName: "Core Model Task Failed",
  description: "Information carried by the core.model.task.failed kind.",
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
    project: ({ payload }) => ({
      event: "model.task.lifecycle",
      status: "failed",
      taskId: payload.taskId,
      taskVersion: payload.version,
      activationDefinitionId: payload.activation.definitionId,
      activationInstanceId: payload.activation.instanceId,
      tier: payload.selectionPolicy.tier,
      providerId: payload.resolvedModel.providerId,
      modelId: payload.resolvedModel.modelId,
      outputMode: payload.outputMode,
      durationMs: payload.durationMs,
      errorKind: payload.error.kind,
      failureStage: payload.error.stage,
    }),
  },
});
export const modelTaskCancelledInformationKind = defineInformationKind({
  kind: "core.model.task.cancelled",
  displayName: "Core Model Task Cancelled",
  description: "Information carried by the core.model.task.cancelled kind.",
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
    project: ({ payload }) => ({
      event: "model.task.lifecycle",
      status: "cancelled",
      taskId: payload.taskId,
      taskVersion: payload.version,
      activationDefinitionId: payload.activation.definitionId,
      activationInstanceId: payload.activation.instanceId,
      tier: payload.selectionPolicy.tier,
      providerId: payload.resolvedModel.providerId,
      modelId: payload.resolvedModel.modelId,
      outputMode: payload.outputMode,
      durationMs: payload.durationMs,
    }),
  },
});

function promptPreview(text: string) {
  const preview = previewInformationContent(text);
  return {
    promptPreview: sanitizePromptForLogging(preview.contentPreview),
    promptTruncated: preview.contentTruncated,
  };
}

function sanitizePromptForLogging(text: string): string {
  return text
    .replace(
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s]+/giu,
      "[REDACTED]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]")
    .replace(
      /\b(api[_-]?key|authorization|bearer|token|password|secret|credential)\s*[:=]\s*[^\s]+/giu,
      "$1=[REDACTED]",
    )
    .replace(/\bBearer\s+[^\s]+/giu, "Bearer [REDACTED]")
    .replace(
      /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gu,
      "[REDACTED PRIVATE MATERIAL]",
    );
}
export const modelTaskInformationKinds = Object.freeze([
  modelTaskRequestedInformationKind,
  modelTaskCompletedInformationKind,
  modelTaskFailedInformationKind,
  modelTaskCancelledInformationKind,
] as const);

export const builtInInformationKinds = Object.freeze([
  runtimeContextInformationKind,
  consumerFailedInformationKind,
  inboundTextInformationKind,
  deliveryRequestedInformationKind,
  deliveryDeliveredInformationKind,
  deliveryFailedInformationKind,
] as const satisfies readonly InformationKindDefinition<string, any>[]);
