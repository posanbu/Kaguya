/**
 * conversationContextInformationKind 注册宿主冻结的背景与目标解析投影，内容日志仅输出目录状态。
 * 出站策略拒绝使用不含 target ID 的失败分支；消费者通过请求引用关联 turn，日志只投影安全字段。
 * Planner 的普通请求日志仅投影任务元数据，不包含 Prompt 预览；显式 content detail 保留受控诊断。
 * 功能概述：定义 Runtime 自有的 context、通用 Model Task 生命周期和投递结果 kind，并聚合内建 DAG。
 * Model Task：四个 modelTask*InformationKind 保存任务版本、选择策略、模型、激活来源与 Prompt
 * provenance；终态使用同一 requested 的 status-of，输出仅为 JSON，具体 schema 由调用方拥有。
 * modelTaskInformationKinds 提供独立注册集合；日志默认投影摘要与 Prompt 预览，debug detail
 * 才投影经凭据清理的完整 Prompt 和 provenance，不包含模型输出或 provider 原始响应。
 * 结构化失败记录解析分类；Provider 请求失败另存有界诊断并投影固定处理建议；
 * 旧失败事实仍按原 schema 分支读取，usage/duration 沿用终态指标。
 * modelTaskProvider*Schema 校验 HTTP 状态、固定 code/type/reason 和可选字段组合；
 * providerFailureAction 只从稳定原因生成运维建议，不读取上游原始 message。
 * 主要职责：Runtime definition 约束严格 payload、直接 caused-by/status-of/context 与
 * requested uses-context 引用及脱敏日志投影；`builtInInformationKinds` 原样复用 Engine
 * 与 modules 的 definitions，保证每个字面 kind 只存在一个对象定义。
 * 代码库关系：`runtime.ts` 用聚合集合初始化 Registry；`model-task.ts` 写通用模型任务原子；系统
 * delivery consumer 写 delivered/failed 原子；业务模块接收同一 completed definition 实例。
 * 输入输出与副作用：所有导出都是无 I/O 的 schema/definition/tuple。requested prompt 会把
 * variable provenance 规范为 JSON；projector 不输出 prompt/output/raw 或凭据。
 * 展示契约：中文名称与职责说明由定义直接提供给 Inspection 和 WebUI，稳定 kind 与协议字段保持不变。
 */
import { createHash } from "node:crypto";

import { consumerFailedInformationKind } from "@kaguya/engine";
import { previewInformationContent } from "@kaguya/logger";
import {
  PROVIDER_ERROR_CODES,
  PROVIDER_ERROR_TYPES,
  type ProviderFailureReason,
} from "@kaguya/llm/client";
import {
  deliveryRequestedInformationKind,
  conversationContextInformationKind,
  targetAuthorizedInformationKind,
  messageConfirmedInformationKind,
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
  displayName: "运行时上下文",
  description:
    "Runtime 建立信息处理上下文时登记的根锚点；后续原子通过上下文引用归属该运行环境，载荷不存业务正文。",
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
  displayName: "平台投递成功",
  description:
    "适配器确认投递完成后记录发送结果；Heartflow 据此闭合回合，历史选择器只将成功投递的助手消息纳入历史。",
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
  displayName: "平台投递失败",
  description:
    "平台发送未完成时记录安全错误和目标信息；Heartflow 与诊断据此结束失败路径，不把已生成正文当作已送达。",
  payloadSchema: z.union([
    z
      .object({
        ...safeDeliveryBaseShape,
        ok: z.literal(false),
        error: nonBlankString,
      })
      .strict(),
    z
      .object({
        ok: z.literal(false),
        adapterId: nonBlankString,
        platform: nonBlankString,
        targetKind: z.enum(["group", "private", "web"]),
        error: z.enum([
          "destination-not-allowed",
          "target-authorization-required",
        ]),
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
    level: "warn",
    project: ({ payload }) => ({
      event: "delivery.lifecycle",
      status: "failed",
      adapterId: payload.adapterId,
      platform: payload.platform,
      errorType: payload.error,
      targetKind:
        "targetKind" in payload ? payload.targetKind : payload.target.kind,
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
const modelTaskSafeErrorBaseSchema = z
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
const structuredOutputFailureSchema = z.enum([
  "empty",
  "invalid-json",
  "schema-mismatch",
  "truncated",
]);
const attemptCountSchema = z.number().int().positive();
export const modelTaskProviderStatusCodeSchema = z
  .number()
  .int()
  .min(100)
  .max(599);
export const modelTaskProviderCodeSchema = z.enum(PROVIDER_ERROR_CODES);
export const modelTaskProviderTypeSchema = z.enum(PROVIDER_ERROR_TYPES);
export const modelTaskProviderReasonSchema = z.enum([
  "authentication-failed",
  "credential-blocked",
  "model-access-denied",
  "rate-limited",
  "invalid-request",
  "model-not-found",
  "provider-unavailable",
  "unknown",
]);
const providerFailureBaseSchema = z
  .object({
    reason: modelTaskProviderReasonSchema,
  })
  .strict();
// 八种可选字段组合各自输出纯 JSON，避免 optional 的 undefined 破坏账本载荷类型。
export const modelTaskProviderFailureSchema = z.union([
  providerFailureBaseSchema.extend({
    statusCode: modelTaskProviderStatusCodeSchema,
    code: modelTaskProviderCodeSchema,
    type: modelTaskProviderTypeSchema,
  }),
  providerFailureBaseSchema.extend({
    statusCode: modelTaskProviderStatusCodeSchema,
    code: modelTaskProviderCodeSchema,
  }),
  providerFailureBaseSchema.extend({
    statusCode: modelTaskProviderStatusCodeSchema,
    type: modelTaskProviderTypeSchema,
  }),
  providerFailureBaseSchema.extend({
    code: modelTaskProviderCodeSchema,
    type: modelTaskProviderTypeSchema,
  }),
  providerFailureBaseSchema.extend({
    statusCode: modelTaskProviderStatusCodeSchema,
  }),
  providerFailureBaseSchema.extend({ code: modelTaskProviderCodeSchema }),
  providerFailureBaseSchema.extend({ type: modelTaskProviderTypeSchema }),
  providerFailureBaseSchema,
]);
const providerFailureAction: Readonly<Record<ProviderFailureReason, string>> = {
  "authentication-failed": "检查或更新 API Key 与鉴权配置",
  "credential-blocked": "检查或更新 API Key；若由组织管理，联系管理员解除封禁",
  "model-access-denied": "核对账号的模型访问授权",
  "rate-limited": "检查额度与限流策略，稍后重试",
  "invalid-request": "核对模型请求参数与 Provider 能力",
  "model-not-found": "核对模型 ID 与 Provider 可用模型列表",
  "provider-unavailable": "检查上游服务状态，稍后重试",
  unknown: "查看 Provider 状态与配置后进一步排查",
};
// 严格联合表达可省略字段，保证每个分支都只产生 JSON，避免 optional 输出包含 undefined。
export const modelTaskSafeErrorSchema = z.union([
  modelTaskSafeErrorBaseSchema.extend({
    stage: z.literal("provider-request"),
    providerFailure: modelTaskProviderFailureSchema,
    attemptCount: attemptCountSchema,
  }),
  modelTaskSafeErrorBaseSchema.extend({
    stage: z.literal("provider-request"),
    providerFailure: modelTaskProviderFailureSchema,
  }),
  modelTaskSafeErrorBaseSchema.extend({
    structuredOutputFailure: structuredOutputFailureSchema,
    attemptCount: attemptCountSchema,
  }),
  modelTaskSafeErrorBaseSchema.extend({ attemptCount: attemptCountSchema }),
  modelTaskSafeErrorBaseSchema.extend({
    structuredOutputFailure: structuredOutputFailureSchema,
  }),
  modelTaskSafeErrorBaseSchema,
]);
export const modelTaskRequestedInformationKind = defineInformationKind({
  kind: "core.model.task.requested",
  displayName: "模型任务请求",
  description:
    "模块通过受控能力提交任务后冻结 Prompt、模型选择和调用归属；Runtime 据此执行或恢复同一任务并保留输入溯源。",
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
      ...(payload.taskId === "agent.turn.plan"
        ? {}
        : promptPreview(payload.prompt.text)),
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
  displayName: "模型任务完成",
  description:
    "模型调用成功后记录输出、实际模型及可用的耗时和用量；原请求模块校验业务语义后再派生领域事实。",
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
  displayName: "模型任务失败",
  description:
    "模型调用在请求、生成或输出校验阶段失败时登记安全错误；调用模块按任务归属处理故障并闭合业务流程。",
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
      ...(!("structuredOutputFailure" in payload.error)
        ? {}
        : { structuredOutputFailure: payload.error.structuredOutputFailure }),
      ...(!("attemptCount" in payload.error)
        ? {}
        : { attemptCount: payload.error.attemptCount }),
      ...(!("providerFailure" in payload.error)
        ? {}
        : {
            ...("statusCode" in payload.error.providerFailure
              ? { providerStatusCode: payload.error.providerFailure.statusCode }
              : {}),
            ...("code" in payload.error.providerFailure
              ? { providerErrorCode: payload.error.providerFailure.code }
              : {}),
            ...("type" in payload.error.providerFailure
              ? { providerErrorType: payload.error.providerFailure.type }
              : {}),
            providerFailureReason: payload.error.providerFailure.reason,
            providerAction:
              providerFailureAction[payload.error.providerFailure.reason],
          }),
    }),
  },
});
export const modelTaskCancelledInformationKind = defineInformationKind({
  kind: "core.model.task.cancelled",
  displayName: "模型任务取消",
  description:
    "收到显式取消请求后记录模型任务的取消终态；调用模块据此停止等待，避免将取消视作成功输出。",
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
  conversationContextInformationKind,
  targetAuthorizedInformationKind,
  messageConfirmedInformationKind,
  runtimeContextInformationKind,
  consumerFailedInformationKind,
  inboundTextInformationKind,
  deliveryRequestedInformationKind,
  deliveryDeliveredInformationKind,
  deliveryFailedInformationKind,
] as const satisfies readonly InformationKindDefinition<string, any>[]);
