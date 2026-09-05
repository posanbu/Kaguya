/**
 * 功能概述：定义 Runtime 自有的 context、LLM 生命周期和投递结果 kind，并聚合整个内建 DAG。
 * 主要职责：Runtime definition 约束严格 payload、直接 caused-by/status-of/context 与
 * requested uses-context 引用及脱敏日志投影；`builtInInformationKinds` 原样复用 Engine
 * 与 modules 的 definitions，保证每个字面 kind 只存在一个对象定义。
 * 代码库关系：`runtime.ts` 用聚合集合初始化 Registry；`llm-lifecycle.ts` 写 LLM 原子；系统
 * delivery consumer 写 delivered/failed 原子；业务模块接收同一 completed definition 实例。
 * 输入输出与副作用：所有导出都是无 I/O 的 schema/definition/tuple。requested prompt 会把
 * fragment metadata 规范为 JSON；projector 不输出 prompt/output/raw 或凭据。
 */
import { consumerFailedInformationKind } from "@kaguya/engine";
import {
  assistantTextInformationKind,
  deliveryRequestedInformationKind,
  filterDecisionInformationKind,
  inboundTextInformationKind,
  informationModuleKinds,
  llmCompletedInformationPayloadSchema as moduleLlmCompletedPayloadSchema,
  replyRequestedInformationKind,
} from "@kaguya/modules";
import {
  type CompiledPrompt,
  type InformationId,
  type JsonObject,
  type PromptFragmentSource,
  compiledPromptSchema,
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
const llmKindSchema = promptKindSchema;
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
const llmMetadataShape = {
  kind: llmKindSchema,
  modelId: nonBlankString,
  workflowId: nonBlankString,
  nodeId: nonBlankString,
  originatingModuleInstanceId: nonBlankString,
};
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

export const llmRequestedInformationKind = defineInformationKind({
  kind: "core.llm.requested",
  payloadSchema: z
    .object({
      ...llmMetadataShape,
      prompt: informationCompiledPromptSchema,
    })
    .strict(),
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [replyRequestedInformationKind.kind],
    },
    "core:context": contextReference,
    "core:uses-context": {
      required: true,
      multiple: true,
    },
  },
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => ({
      event: "llm.lifecycle",
      status: "requested",
      llmKind: payload.kind,
      modelId: payload.modelId,
      workflowId: payload.workflowId,
      nodeId: payload.nodeId,
      originatingModuleInstanceId: payload.originatingModuleInstanceId,
    }),
  },
});

const llmCompletedPayloadShape = {
  ...moduleLlmCompletedPayloadSchema.shape,
  ...llmMetadataShape,
  durationMs: z.number().nonnegative(),
};
export const llmCompletedInformationPayloadSchema = z.union([
  z
    .object({
      ...llmCompletedPayloadShape,
      usage: z.record(z.string(), z.number()),
    })
    .strict(),
  z.object(llmCompletedPayloadShape).strict(),
]);
export type LlmCompletedInformationPayload = z.infer<
  typeof llmCompletedInformationPayloadSchema
>;

export const llmCompletedInformationKind = defineInformationKind({
  kind: "core.llm.completed",
  payloadSchema: llmCompletedInformationPayloadSchema,
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [llmRequestedInformationKind.kind],
    },
    "core:status-of": {
      required: true,
      multiple: false,
      targetKinds: [llmRequestedInformationKind.kind],
    },
    "core:context": contextReference,
  },
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => ({
      event: "llm.lifecycle",
      status: "completed",
      llmKind: payload.kind,
      modelId: payload.modelId,
      workflowId: payload.workflowId,
      nodeId: payload.nodeId,
      originatingModuleInstanceId: payload.originatingModuleInstanceId,
      durationMs: payload.durationMs,
    }),
  },
});

export const llmFailedInformationKind = defineInformationKind({
  kind: "core.llm.failed",
  payloadSchema: z
    .object({
      ...llmMetadataShape,
      error: z
        .object({
          name: nonBlankString,
          kind: z.enum(["retryable", "non-retryable", "cancelled"]),
          message: nonBlankString,
        })
        .strict(),
    })
    .strict(),
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [llmRequestedInformationKind.kind],
    },
    "core:status-of": {
      required: true,
      multiple: false,
      targetKinds: [llmRequestedInformationKind.kind],
    },
    "core:context": contextReference,
  },
  log: {
    enabled: true,
    level: "error",
    project: ({ payload }) => ({
      event: "llm.lifecycle",
      status: "failed",
      llmKind: payload.kind,
      modelId: payload.modelId,
      workflowId: payload.workflowId,
      nodeId: payload.nodeId,
      originatingModuleInstanceId: payload.originatingModuleInstanceId,
      errorType: payload.error.name,
      errorKind: payload.error.kind,
    }),
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

export const builtInInformationKinds = Object.freeze([
  runtimeContextInformationKind,
  consumerFailedInformationKind,
  ...informationModuleKinds,
  llmRequestedInformationKind,
  llmCompletedInformationKind,
  llmFailedInformationKind,
  deliveryDeliveredInformationKind,
  deliveryFailedInformationKind,
] as const satisfies readonly InformationKindDefinition<string, any>[]);
