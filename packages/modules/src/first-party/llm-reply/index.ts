/**
 * 功能概述：通过宿主批准的 Model Task 能力将回复请求、通用完成事实、assistant 与投递组成 durable DAG。
 * 主要职责：createLlmReplyModule 声明能力和共享 completed definition；reply handler 经
 * context.select 重载冻结 turn、同会话历史与可选 Memory，再通过 context.use 调用 core.reply.generate v2，
 * replyTaskOutputSchema 严格校验文本。完成 handler 按 task/version/tier
 * 与 definitionId 接受可由同一定义多个 activation 共享的任务赢家，经 completedReplySelector 沿
 * completed→requested→reply 授权读取来源，再以包含当前 instanceId 的 registerOnce key 派生各自输出。
 * 代码库关系：Runtime 注入 token 和 definition 身份，Host 提供 activation、受限 Selector 与 claim fencing；
 * reply-context 按固定中文层次组装 Prompt 并保留 provenance，selectOutbound 保留 source/fixed 路由。
 * ModelTaskRequest/Result/Capability 是模块侧结构类型；completed definition 的泛型保留宿主 payload
 * 与日志投影契约，不导入 Runtime source/dist、provider、模型、密钥或 Core，也不创建第二份 token。
 * 输入输出与副作用：requested/terminal 生命周期完全归 ModelTaskClient；failed/cancelled 不触发业务写入，
 * completed 广播仅校验获胜 definition、不校验 instance；assistant 按自身 originating instance 过滤，
 * 重投使用唯一操作槽；回复任务的公共输出契约是经过裁剪且非空的纯文本。
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
  defineModuleDiagnostic,
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
  inboundTextInformationKind,
  replyRequestedInformationKind,
  replyRequestedInformationPayloadSchema,
  type ReplyRequestedInformationPayload,
} from "../information-kinds.js";
import {
  compileReplyPromptFromInformation,
  inboundMemoryPromptRenderer,
  assistantHistoryPromptRenderer,
  replyPromptRenderer,
  memoryPromptRenderer,
  currentAcceptedMessageSelector,
  turnReplyContextSelector,
} from "./reply-context.js";
import { ZH_CN_REPLY_PROMPT } from "./reply-prompt.js";

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

export const replyModelDispatchingDiagnostic = defineModuleDiagnostic({
  event: "reply.model.dispatching",
  message: "Reply model task dispatching",
  level: "info",
  payloadSchema: z
    .object({
      taskId: z.literal("core.reply.generate"),
      taskVersion: z.literal("2"),
      outputMode: z.literal("text"),
      promptVersion: z.literal("zh-CN/v1"),
      tier: modelTierSchema,
      promptCharacters: z.number().int().nonnegative(),
      promptFragmentCount: z.number().int().nonnegative(),
      historyMessageCount: z.number().int().nonnegative(),
      historyCharacters: z.number().int().nonnegative(),
      memoryCharacters: z.number().int().nonnegative(),
      targetCharacters: z.number().int().nonnegative(),
    })
    .strict(),
  project: (payload) => ({ ...payload }),
});

export const replyTaskOutputSchema = z.string().trim().min(1);

export interface ModelTaskRequest<TOutput> {
  readonly task: {
    readonly taskId: string;
    readonly version: string;
    readonly outputMode: "text" | "object";
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
          readonly stage:
            | "provider-request"
            | "structured-output-parse"
            | "task-schema-validation";
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
  readonly selectionPolicy: { readonly tier: "light" | "heavy" };
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
  const selector = dependencies.selector ?? turnReplyContextSelector;
  const promptCompiler = dependencies.promptCompiler ?? new PromptCompiler();
  const completedInformationKind =
    dependencies.modelTaskCompletedInformationKind;
  return defineInformationModule({
    manifest: {
      protocolVersion: 2,
      moduleVersion: "1.0.0",
      selectors: [
        selector,
        ...(selector === currentAcceptedMessageSelector
          ? []
          : [currentAcceptedMessageSelector]),
        completedReplySelector,
      ],
      promptRenderers: [
        replyPromptRenderer,
        memoryPromptRenderer,
        inboundMemoryPromptRenderer,
        assistantHistoryPromptRenderer,
      ],
      requires: [modelTaskCapability],
      provides: [],
      definitionId: "demo.reply.llm",
      displayName: "LLM reply",
      summary: "Generates a reply from an explicitly selected turn context.",
      description:
        "Compiles explicitly selected frozen context, dispatches one structured Model Task, and records assistant and delivery requests. It generates reply text but does not decide whether an event deserves attention or perform general planning.",
      settingsSchema: llmReplySettingsSchema,
      consumes: [
        replyRequestedInformationKind,
        completedInformationKind,
        assistantTextInformationKind,
        coreMemoryTextInformationKind,
        inboundTextInformationKind,
      ],
      produces: [
        assistantTextInformationKind,
        deliveryRequestedInformationKind,
      ],
      diagnostics: [replyModelDispatchingDiagnostic],
    },
    create: ({ settings, activation }) => ({
      provisions: [],
      describeStartup: () => ({
        summary: "LLM reply pipeline ready",
        fields: {
          modelTier: settings.modelTier,
          outboundMode: settings.outbound.mode,
          ...(settings.outbound.mode === "source"
            ? { messageKind: settings.outbound.messageKind }
            : {}),
        },
      }),
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
              persistedReply.informationId,
            );
            const contexts = persistedReply.references.filter(
              (r) => r.relation === "core:context",
            );
            if (contexts.length !== 1)
              throw new Error("Reply must have one context");
            await context.report(replyModelDispatchingDiagnostic, {
              taskId: "core.reply.generate",
              taskVersion: "2",
              outputMode: "text",
              promptVersion: ZH_CN_REPLY_PROMPT.version,
              tier: settings.modelTier,
              promptCharacters: Array.from(prompt.text).length,
              promptFragmentCount: prompt.fragments.length,
              historyMessageCount: prompt.fragments.filter(
                ({ source }) => source === "history",
              ).length,
              historyCharacters: fragmentCharacters(prompt, "history"),
              memoryCharacters: fragmentCharacters(prompt, "memory"),
              targetCharacters: fragmentCharacters(prompt, "state"),
            });
            await context.use(modelTaskCapability).execute({
              task: {
                taskId: "core.reply.generate",
                version: "2",
                outputMode: "text",
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
              completed.payload.version !== "2" ||
              completed.payload.activation.definitionId !==
                activation.definitionId ||
              completed.payload.selectionPolicy.tier !== settings.modelTier
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
              `${context.instanceId}:${completed.informationId}`,
              assistantTextInformationKind,
              {
                payload: {
                  text: output,
                  source: reply.payload.source,
                  originatingModuleInstanceId: context.instanceId,
                  turn: (reply.payload as any).turn ?? null,
                },
              },
            );
          },
        ),
        onInformation(
          assistantTextInformationKind,
          { subscriptionId: "kaguya.reply.assistant", delivery: "durable" },
          async (assistant, context) => {
            const assistantPayload =
              assistantTextInformationKind.payloadSchema.parse(
                assistant.payload,
              );
            if (
              assistantPayload.originatingModuleInstanceId !==
              context.instanceId
            )
              return;
            const outbound = selectOutbound(
              assistantPayload.source,
              settings.outbound,
              assistantPayload.text,
            );
            if (outbound === undefined) return;
            await context.registerOnce(
              "kaguya.reply.delivery.v1",
              `${context.instanceId}:${assistant.informationId}`,
              deliveryRequestedInformationKind,
              {
                payload: {
                  ...outbound,
                  turn: assistantPayload.turn,
                },
                references:
                  assistantPayload.turn == null
                    ? []
                    : [
                        {
                          relation: "agent:turn-claim" as const,
                          informationId:
                            assistantPayload.turn.claimInformationId,
                        },
                        {
                          relation: "agent:turn-candidate" as const,
                          informationId:
                            assistantPayload.turn.candidateInformationId,
                        },
                      ],
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

function fragmentCharacters(
  prompt: CompiledPrompt,
  source: "history" | "memory" | "state",
): number {
  return prompt.fragments
    .filter((fragment) => fragment.source === source)
    .reduce(
      (total, fragment) => total + Array.from(fragment.content).length,
      0,
    );
}
