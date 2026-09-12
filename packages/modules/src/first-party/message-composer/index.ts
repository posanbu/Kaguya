/**
 * 功能概述：消息编写模块消费 Heartflow 产生的目标与冻结 turn 意图，经通用 Model Task 生成文本。
 * 主要职责：createMessageComposerModule 装配三个 durable 订阅；messageTaskOutputSchema 校验非空文本；
 * messageComposerSettingsSchema 只允许 modelTier。完成选择器沿 completed→requested→intent 核对任务来源，
 * 再以实例与事实 ID 为 registerOnce 键分别记录 assistant 和纯文本投递，重复事件不产生重复业务输出。
 * 代码库关系：message-context 选择冻结上下文，message-prompt 编译全部本轮输入；Runtime 注入模型能力及完成定义。
 * 输入输出与副作用：意图只携带 target、turn 与 memoryInformationIds；assistant.source 保留 target，
 * 不复制入站正文或消息 ID，不提供固定路由或自动引用回复。失败或取消的模型任务不产生 assistant。
 */
import {
  type CompiledPrompt,
  type DeepReadonly,
  type InformationAtom,
  type JsonObject,
  type JsonValue,
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

import {
  assistantTextInformationKind,
  coreMemoryTextInformationKind,
  deliveryRequestedInformationKind,
  inboundTextInformationKind,
  messageIntentRequestedInformationKind,
  messageIntentRequestedInformationPayloadSchema,
  type MessageIntentRequestedInformationPayload,
} from "../information-kinds.js";
import {
  inboundMemoryPromptRenderer,
  assistantHistoryPromptRenderer,
  messagePromptRenderer,
  memoryPromptRenderer,
  currentAcceptedMessageSelector,
  turnMessageContextSelector,
} from "./message-context.js";
import {
  createMessagePromptCompiler,
  ZH_CN_MESSAGE_PROMPT,
  type AgentIdentity,
  type MessagePromptTemplates,
} from "./message-prompt.js";

export const modelTierSchema = z.enum(["light", "heavy"]);
export type ModelTier = z.infer<typeof modelTierSchema>;

export interface ModuleModelSelection {
  readonly modelTier: ModelTier;
}

export type {
  AgentIdentity,
  MessagePromptTemplates,
} from "./message-prompt.js";

export const messageComposerSettingsSchema = z
  .object({ modelTier: modelTierSchema })
  .strict();
export type MessageComposerSettings = z.infer<
  typeof messageComposerSettingsSchema
>;

export const messageModelDispatchingDiagnostic = defineModuleDiagnostic({
  event: "message.model.dispatching",
  message: "Message model task dispatching",
  level: "info",
  payloadSchema: z
    .object({
      taskId: z.literal("agent.message.compose"),
      taskVersion: z.literal("1"),
      outputMode: z.literal("text"),
      promptVersion: z.literal("zh-CN/v3"),
      tier: modelTierSchema,
      promptCharacters: z.number().int().nonnegative(),
      promptVariableCount: z.number().int().nonnegative(),
      historyMessageCount: z.number().int().nonnegative(),
      historyCharacters: z.number().int().nonnegative(),
      memoryCharacters: z.number().int().nonnegative(),
      turnCharacters: z.number().int().nonnegative(),
    })
    .strict(),
  project: (payload) => ({ ...payload }),
});

export const messageTaskOutputSchema = z.string().trim().min(1);

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

export interface CreateMessageComposerModuleOptions<
  P extends ModelTaskCompletedInformationPayload =
    ModelTaskCompletedInformationPayload,
> {
  readonly modelTaskCapability: ModuleCapability<ModelTaskCapability>;
  readonly modelTaskCompletedInformationKind: InformationKindDefinition<
    "core.model.task.completed",
    P
  >;
  readonly selector?: InformationSelectorDefinition;
  readonly promptTemplates: MessagePromptTemplates;
  readonly agentIdentity: AgentIdentity;
}

export function createMessageComposerModule<
  P extends ModelTaskCompletedInformationPayload,
>(dependencies: CreateMessageComposerModuleOptions<P>) {
  const { modelTaskCapability } = dependencies;
  if (
    modelTaskCapability.id !== "kaguya:model-task" ||
    modelTaskCapability.apiVersion !== 1
  )
    throw new Error("Invalid model task capability");
  const selector = dependencies.selector ?? turnMessageContextSelector;
  const compilePrompt = createMessagePromptCompiler(
    dependencies.promptTemplates,
    dependencies.agentIdentity,
  );
  const completedInformationKind =
    dependencies.modelTaskCompletedInformationKind;
  return defineInformationModule({
    manifest: {
      protocolVersion: 1,
      moduleVersion: "1.0.0",
      selectors: [
        selector,
        ...(selector === currentAcceptedMessageSelector
          ? []
          : [currentAcceptedMessageSelector]),
        completedMessageSelector,
      ],
      promptRenderers: [
        messagePromptRenderer,
        memoryPromptRenderer,
        inboundMemoryPromptRenderer,
        assistantHistoryPromptRenderer,
      ],
      requires: [modelTaskCapability],
      provides: [],
      definitionId: "agent.message-composer",
      displayName: "Message composer",
      summary: "Generates a message from an explicitly selected turn context.",
      description:
        "Compiles explicitly selected frozen context, dispatches one text Model Task, and records assistant and delivery requests. It generates message text but does not decide whether an event deserves attention or perform general planning.",
      settingsSchema: messageComposerSettingsSchema,
      consumes: [
        messageIntentRequestedInformationKind,
        completedInformationKind,
        assistantTextInformationKind,
        coreMemoryTextInformationKind,
        inboundTextInformationKind,
      ],
      produces: [
        assistantTextInformationKind,
        deliveryRequestedInformationKind,
      ],
      diagnostics: [messageModelDispatchingDiagnostic],
    },
    create: ({ settings, activation }) => ({
      provisions: [],
      describeStartup: () => ({
        summary: "Message composer pipeline ready",
        fields: {
          modelTier: settings.modelTier,
        },
      }),
      subscriptions: [
        onInformation(
          messageIntentRequestedInformationKind,
          { subscriptionId: "kaguya.message.requested", delivery: "durable" },
          async (message, context) => {
            const contextAtoms = await context.select(selector);
            const persistedIntent = requireSelectedMessageIntent(
              contextAtoms,
              message.informationId,
            );
            const prompt = compilePrompt(
              contextAtoms,
              persistedIntent.informationId,
            );
            const contexts = persistedIntent.references.filter(
              (r) => r.relation === "core:context",
            );
            if (contexts.length !== 1)
              throw new Error("Message intent must have one context");
            await context.report(messageModelDispatchingDiagnostic, {
              taskId: "agent.message.compose",
              taskVersion: "1",
              outputMode: "text",
              promptVersion: ZH_CN_MESSAGE_PROMPT.version,
              tier: settings.modelTier,
              promptCharacters: Array.from(prompt.text).length,
              promptVariableCount: prompt.variables.length,
              historyMessageCount:
                prompt.variables.find(({ name }) => name === "history")
                  ?.informationIds.length ?? 0,
              historyCharacters: variableCharacters(prompt, "history"),
              memoryCharacters: variableCharacters(prompt, "memory"),
              turnCharacters: variableCharacters(prompt, "turn"),
            });
            await context.use(modelTaskCapability).execute({
              task: {
                taskId: "agent.message.compose",
                version: "1",
                outputMode: "text",
                outputSchema: messageTaskOutputSchema,
                allowedTiers: ["light", "heavy"],
              },
              sourceInformationId: persistedIntent.informationId,
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
            subscriptionId: "kaguya.message.model-task-completed",
            delivery: "durable",
          },
          async (completed, context) => {
            if (
              completed.payload.taskId !== "agent.message.compose" ||
              completed.payload.version !== "1" ||
              completed.payload.activation.definitionId !==
                activation.definitionId ||
              completed.payload.selectionPolicy.tier !== settings.modelTier
            )
              return;
            const output = messageTaskOutputSchema.parse(
              completed.payload.output,
            );
            const message = requireSelectedMessageIntent(
              await context.select(completedMessageSelector),
              completed.payload.sourceInformationId,
            );
            await context.registerOnce(
              "kaguya.message.assistant.v1",
              `${context.instanceId}:${completed.informationId}`,
              assistantTextInformationKind,
              {
                payload: {
                  text: output,
                  source: message.payload.target,
                  originatingModuleInstanceId: context.instanceId,
                  turn: message.payload.turn,
                },
              },
            );
          },
        ),
        onInformation(
          assistantTextInformationKind,
          { subscriptionId: "kaguya.message.assistant", delivery: "durable" },
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
            await context.registerOnce(
              "kaguya.message.delivery.v1",
              `${context.instanceId}:${assistant.informationId}`,
              deliveryRequestedInformationKind,
              {
                payload: {
                  adapterId: assistantPayload.source.adapterId,
                  platform: assistantPayload.source.platform,
                  destination: assistantPayload.source.destination,
                  message: { kind: "text", text: assistantPayload.text },
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

const completedMessageSelector = defineInformationSelector({
  selectorId: "kaguya.message.completed-source",
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
    const message = sources[0];
    if (
      message?.kind !== messageIntentRequestedInformationKind.kind ||
      message.informationId !== payload.sourceInformationId
    )
      throw new Error(
        "Model task completion source must match its message intent cause",
      );
    return [message.informationId];
  },
});

function requireSelectedMessageIntent(
  atoms: readonly DeepReadonly<InformationAtom>[],
  informationId: string,
): DeepReadonly<
  InformationAtom<
    "agent.message.intent.requested",
    MessageIntentRequestedInformationPayload
  >
> {
  const message = atoms.find((atom) => atom.informationId === informationId);
  if (message === undefined) {
    throw new Error("Message selection must include the current input");
  }
  if (message.kind !== messageIntentRequestedInformationKind.kind) {
    throw new Error(
      `Selected message intent has unexpected information kind: ${message.kind}`,
    );
  }
  messageIntentRequestedInformationPayloadSchema.parse(message.payload);
  return message as DeepReadonly<
    InformationAtom<
      "agent.message.intent.requested",
      MessageIntentRequestedInformationPayload
    >
  >;
}

function variableCharacters(prompt: CompiledPrompt, name: string): number {
  return Array.from(
    prompt.variables.find((variable) => variable.name === name)?.content ?? "",
  ).length;
}
