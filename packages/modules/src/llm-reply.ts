/**
 * 功能概述：通过宿主批准的 Model Task 能力将回复请求、通用完成事实、assistant 与投递组成 durable DAG。
 * 主要职责：createLlmReplyModule 声明能力和共享 completed definition；请求 handler 经 context.use
 * 调用 core.reply.generate v1，replyTaskOutputSchema 严格校验文本。完成 handler 仅处理本 activation
 * 的任务赢家，经 completedReplySelector 沿 completed→requested→reply 授权读取来源，
 * 再用 registerOnce 派生 assistant 和 delivery。
 * 代码库关系：Runtime 注入 token 和 definition 身份，Host 提供 activation、受限 Selector 与 claim fencing；
 * reply-context 保留原有 Prompt/Memory 顺序与 provenance，selectOutbound 保留 source/fixed 路由。
 * ModelTaskRequest/Result/Capability 是模块侧结构类型；completed definition 的泛型保留宿主 payload
 * 与日志投影契约，不导入 Runtime source/dist、provider、模型、密钥或 Core，也不创建第二份 token。
 * 输入输出与副作用：requested/terminal 生命周期完全归 ModelTaskClient；failed/cancelled 不触发业务写入，
 * completed 与 assistant 广播按 originating activation 过滤，重投使用唯一操作槽，不保存请求内存状态。
 */
import {
  type CompiledPrompt,
  type DeepReadonly,
  type InformationAtom,
  type JsonObject,
  type JsonValue,
  type OutboundMessageContent,
  type PlatformDestination,
  z,
} from "@kaguya/schema";
import {
  defineInformationModule,
  defineInformationSelector,
  type InformationKindDefinition,
  type ModuleCapability,
  type ModuleActivationProvenance,
  onInformation,
  type InformationSelectorDefinition,
} from "@kaguya/sdk";
import { PromptCompiler } from "@kaguya/prompt";

import {
  assistantTextInformationKind,
  coreMemoryTextInformationKind,
  deliveryRequestedInformationKind,
  replyRequestedInformationKind,
  replyRequestedInformationPayloadSchema,
  type ReplyRequestedInformationPayload,
} from "./information-kinds.js";
import {
  compileReplyPromptFromInformation,
  currentAcceptedMessageSelector,
  replyPromptRenderer,
  memoryPromptRenderer,
} from "./reply-context.js";

export const modelTierSchema = z.enum(["light", "heavy"]);
export type ModelTier = z.infer<typeof modelTierSchema>;

export interface ModuleModelSelection {
  readonly modelTier: ModelTier;
}

const sourceOutboundSchema = z
  .object({
    mode: z.literal("source"),
    messageKind: z.enum(["text", "reply"]),
  })
  .strict();

const fixedOutboundSchema = z
  .object({
    mode: z.literal("fixed"),
    adapterId: z.string().trim().min(1),
    platform: z.string().trim().min(1),
    destination: z.discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("private"), userId: z.string().min(1) })
        .strict(),
      z
        .object({ kind: z.literal("group"), groupId: z.string().min(1) })
        .strict(),
    ]),
  })
  .strict();

export const llmReplySettingsSchema = z
  .object({
    modelTier: modelTierSchema,
    outbound: z.discriminatedUnion("mode", [
      sourceOutboundSchema,
      fixedOutboundSchema,
    ]),
  })
  .strict();
export type LlmReplySettings = z.infer<typeof llmReplySettingsSchema>;

export const llmCompletedInformationPayloadSchema = z
  .object({
    output: z.object({ text: z.string().min(1) }).strict(),
    reply: replyRequestedInformationPayloadSchema,
    originatingModuleInstanceId: z.string().trim().min(1),
  })
  .strict();
export type LlmCompletedInformationPayload = z.infer<
  typeof llmCompletedInformationPayloadSchema
>;

export const replyTaskOutputSchema = z
  .object({ text: z.string().min(1) })
  .strict();

export interface ModelTaskRequest<TOutput> {
  readonly task: {
    readonly taskId: string;
    readonly version: string;
    readonly outputSchema: z.ZodType<TOutput>;
    readonly allowedTiers: readonly ("light" | "heavy")[];
  };
  readonly sourceInformationId: string;
  readonly contextInformationId: string;
  readonly activation: ModuleActivationProvenance;
  readonly selectionPolicy: { readonly tier: "light" | "heavy" };
  readonly prompt: CompiledPrompt;
  readonly contextAtoms: readonly DeepReadonly<InformationAtom>[];
}

type ModelTaskResultIdentity = {
  readonly requestedInformationId: string;
  readonly terminalInformationId: string;
};

export type ModelTaskResult<TOutput> = ModelTaskResultIdentity &
  (
    | { readonly status: "completed"; readonly output: TOutput }
    | {
        readonly status: "failed";
        readonly error: {
          readonly name: "ModelTaskError";
          readonly kind: "retryable" | "non-retryable";
          readonly message: "Model task generation failed";
        };
      }
    | {
        readonly status: "cancelled";
        readonly reason: "Explicit cancellation requested";
      }
  );

export interface ModelTaskCapability {
  execute<TOutput>(
    request: ModelTaskRequest<TOutput>,
  ): Promise<ModelTaskResult<TOutput>>;
  cancel(request: {
    readonly requestedInformationId: string;
    readonly reason: string;
  }): Promise<ModelTaskResult<unknown>>;
}

export type ModelTaskCompletedInformationPayload = JsonObject & {
  readonly taskId: string;
  readonly version: string;
  readonly sourceInformationId: string;
  readonly activation: {
    readonly instanceId: string;
    readonly definitionId: string;
  };
  readonly output: JsonValue;
};

export interface CreateLlmReplyModuleOptions<
  P extends ModelTaskCompletedInformationPayload =
    ModelTaskCompletedInformationPayload,
> {
  readonly modelTaskCapability: ModuleCapability<ModelTaskCapability>;
  readonly modelTaskCompletedInformationKind: InformationKindDefinition<
    "core.model.task.completed",
    P
  >;
  readonly selector?: InformationSelectorDefinition;
  readonly promptCompiler?: PromptCompiler;
}

export function createLlmReplyModule<
  P extends ModelTaskCompletedInformationPayload,
>(dependencies: CreateLlmReplyModuleOptions<P>) {
  const { modelTaskCapability } = dependencies;
  if (
    modelTaskCapability.id !== "kaguya:model-task" ||
    modelTaskCapability.apiVersion !== 1
  )
    throw new Error("Invalid model task capability");
  const selector = dependencies.selector ?? currentAcceptedMessageSelector;
  const promptCompiler = dependencies.promptCompiler ?? new PromptCompiler();
  const completedInformationKind =
    dependencies.modelTaskCompletedInformationKind;
  return defineInformationModule({
    manifest: {
      protocolVersion: 1,
      moduleVersion: "1.0.0",
      selectors: [selector, completedReplySelector],
      promptRenderers: [replyPromptRenderer, memoryPromptRenderer],
      requires: [modelTaskCapability],
      provides: [],
      definitionId: "demo.reply.llm",
      displayName: "LLM reply",
      settingsSchema: llmReplySettingsSchema,
      consumes: [
        replyRequestedInformationKind,
        completedInformationKind,
        assistantTextInformationKind,
        coreMemoryTextInformationKind,
      ],
      produces: [
        assistantTextInformationKind,
        deliveryRequestedInformationKind,
      ],
    },
    create: ({ settings, activation }) => ({
      provisions: [],
      subscriptions: [
        onInformation(
          replyRequestedInformationKind,
          { subscriptionId: "kaguya.reply.requested", delivery: "durable" },
          async (reply, context) => {
            const contextAtoms = await context.select(selector);
            const persistedReply = requireSelectedReply(
              contextAtoms,
              reply.informationId,
            );
            const prompt = compileReplyPromptFromInformation(
              promptCompiler,
              contextAtoms,
              reply.informationId,
            );
            const contexts = persistedReply.references.filter(
              (r) => r.relation === "core:context",
            );
            if (contexts.length !== 1)
              throw new Error("Reply must have one context");
            await context.use(modelTaskCapability).execute({
              task: {
                taskId: "core.reply.generate",
                version: "1",
                outputSchema: replyTaskOutputSchema,
                allowedTiers: ["light", "heavy"],
              },
              sourceInformationId: persistedReply.informationId,
              contextInformationId: contexts[0]!.informationId,
              activation,
              selectionPolicy: { tier: settings.modelTier },
              prompt,
              contextAtoms,
            });
          },
        ),
        onInformation(
          completedInformationKind,
          {
            subscriptionId: "kaguya.reply.model-task-completed",
            delivery: "durable",
          },
          async (completed, context) => {
            if (
              completed.payload.taskId !== "core.reply.generate" ||
              completed.payload.version !== "1" ||
              completed.payload.activation.instanceId !==
                activation.instanceId ||
              completed.payload.activation.definitionId !==
                activation.definitionId
            )
              return;
            const output = replyTaskOutputSchema.parse(
              completed.payload.output,
            );
            const reply = requireSelectedReply(
              await context.select(completedReplySelector),
              completed.payload.sourceInformationId,
            );
            await context.registerOnce(
              "kaguya.reply.assistant.v1",
              completed.informationId,
              assistantTextInformationKind,
              {
                payload: {
                  text: output.text,
                  source: reply.payload.source,
                  originatingModuleInstanceId: context.instanceId,
                },
              },
            );
          },
        ),
        onInformation(
          assistantTextInformationKind,
          { subscriptionId: "kaguya.reply.assistant", delivery: "durable" },
          async (assistant, context) => {
            if (
              assistant.payload.originatingModuleInstanceId !==
              context.instanceId
            )
              return;
            const outbound = selectOutbound(
              assistant.payload.source,
              settings.outbound,
              assistant.payload.text,
            );
            if (outbound === undefined) return;
            await context.registerOnce(
              "kaguya.reply.delivery.v1",
              assistant.informationId,
              deliveryRequestedInformationKind,
              {
                payload: outbound,
              },
            );
          },
        ),
      ],
    }),
  });
}

const completedReplySelector = defineInformationSelector({
  selectorId: "kaguya.reply.completed-source",
  select: async ({ sourceAtom, ledger }) => {
    const payload = z
      .object({ sourceInformationId: z.string().min(1) })
      .parse(sourceAtom.payload);
    const requested = await ledger.related({
      from: [sourceAtom.informationId],
      relation: "core:caused-by",
      direction: "outgoing",
      limit: 1,
    });
    if (requested[0]?.kind !== "core.model.task.requested")
      throw new Error("Model task completion must reference its request");
    const sources = await ledger.related({
      from: [requested[0].informationId],
      relation: "core:caused-by",
      direction: "outgoing",
      limit: 1,
    });
    const reply = sources[0];
    if (
      reply?.kind !== replyRequestedInformationKind.kind ||
      reply.informationId !== payload.sourceInformationId
    )
      throw new Error(
        "Model task completion source must match its reply cause",
      );
    return [reply.informationId];
  },
});

function requireSelectedReply(
  atoms: readonly DeepReadonly<InformationAtom>[],
  informationId: string,
): DeepReadonly<
  InformationAtom<"core.reply.requested", ReplyRequestedInformationPayload>
> {
  const reply = atoms.find((atom) => atom.informationId === informationId);
  if (reply === undefined) {
    throw new Error("Reply selection must include the current input");
  }
  if (reply.kind !== replyRequestedInformationKind.kind) {
    throw new Error(
      `Selected reply has unexpected information kind: ${reply.kind}`,
    );
  }
  replyRequestedInformationPayloadSchema.parse(reply.payload);
  return reply as DeepReadonly<
    InformationAtom<"core.reply.requested", ReplyRequestedInformationPayload>
  >;
}

function selectOutbound(
  source: ReplyRequestedInformationPayload["source"],
  setting: LlmReplySettings["outbound"],
  text: string,
):
  | {
      readonly adapterId: string;
      readonly platform: string;
      readonly destination: PlatformDestination;
      readonly message: OutboundMessageContent;
    }
  | undefined {
  if (setting.mode === "fixed") {
    return {
      adapterId: setting.adapterId,
      platform: setting.platform,
      destination: setting.destination,
      message: { kind: "text", text },
    };
  }
  if (source.destination.kind === "web") {
    return {
      adapterId: source.adapterId,
      platform: source.platform,
      destination: source.destination,
      message: { kind: "text", text },
    };
  }
  return {
    adapterId: source.adapterId,
    platform: source.platform,
    destination: source.destination,
    message:
      setting.messageKind === "reply"
        ? {
            kind: "reply",
            replyToPlatformMessageId: source.platformMessageId,
            text,
          }
        : { kind: "text", text },
  };
}
