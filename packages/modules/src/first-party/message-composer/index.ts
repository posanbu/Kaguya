/**
 * 消费人工录入来源 Kind，正文编译经正常记忆变量保留来源，不修改身份或规则模板。
 * manifest.promptTemplates 显式声明消息模板组，供管理端按归属读取。
 * modelTier 的公开中文 schema 元数据由全局配置表单消费，保存仍使用同一校验。
 * 功能概述：消息编写模块消费 Heartflow 产生的目标与冻结 turn 意图，经通用 Model Task 生成文本。
 * 宿主授权能力在选取上下文前校验目标；跨会话只使用批准 Prompt，正文确认后才通过同一 release 创建 delivery。
 * 普通回复也调用宿主冻结背景，仅追加 background 投影，不把其他会话目标引用或 ID 传给正文模型。
 * 场景、人物背景与表达习惯均使用外部模板；背景和表达 renderer 在模块构造时按声明编译，只记录实际追加的模板和变量。
 * 主要职责：createMessageComposerModule 装配三个 durable 订阅；messageTaskOutputSchema 校验非空文本；
 * messageComposerSettingsSchema 只允许 modelTier。完成选择器沿 completed→requested→intent 核对任务来源，
 * 再以实例与事实 ID 为 registerOnce 键分别记录 assistant 和纯文本投递，重复事件不产生重复业务输出。
 * 代码库关系：message-context 选择冻结上下文，message-prompt 编译全部本轮输入；Runtime 注入模型能力及完成定义。
 * 输入输出与副作用：意图只携带 target、turn 与 memoryInformationIds；assistant.source 保留 target，
 * 不复制入站正文或消息 ID，不提供固定路由或自动引用回复。失败或取消的模型任务不产生 assistant。
 * 展示契约：Manifest 直接提供中文名称、摘要及输入输出职责，供 Inspection 与 WebUI 展示。
 * inspection 声明本模块的只读机制、领域数据和历史视图，由 Host/Server 投影给开发者控制台。
 */
import { userStatementInformationKind } from "../memory-knowledge/ingestion-kinds.js";
import { firstPartyInspection } from "../inspection.js";
import { expressionSelected, expressionReady } from "../expression/facts.js";
import {
  expressionDispatchSelector,
  withExpressionContext,
  expressionPrompt,
} from "../expression/composer-context.js";
import {
  messageModulePromptTemplates,
  messageTemplateDeclarations,
} from "../../prompt-declarations.js";
import { createPromptTemplateRenderer } from "../../prompt-template.js";
import {
  messageConfirmedInformationKind,
  type MessageAuthorization,
} from "../message-authorization.js";
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
  type InformationModuleHandlerContext,
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
  .object({
    modelTier: modelTierSchema.meta({
      title: "模型层级",
      description: "消息编写使用的模型层级，由 Profile 映射到提供商与模型。",
      public: true,
      default: "heavy",
    }),
  })
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
      promptVersion: z.literal("zh-CN/v1"),
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
  readonly messageAuthorizationCapability?: ModuleCapability<MessageAuthorization>;
  readonly modelTaskCompletedInformationKind: InformationKindDefinition<
    "core.model.task.completed",
    P
  >;
  readonly expressionEnabled?: boolean;
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
  const baseSelector = dependencies.selector ?? turnMessageContextSelector;
  const selector = dependencies.expressionEnabled
    ? withExpressionContext(baseSelector)
    : baseSelector;
  const compilePrompt = createMessagePromptCompiler(
    dependencies.promptTemplates,
    dependencies.agentIdentity,
  );
  const renderBackground = createContextPromptRenderer(
    dependencies.promptTemplates,
    "conversationBackground",
  );
  const renderHabits = createContextPromptRenderer(
    dependencies.promptTemplates,
    "expressionHabits",
  );
  const completedInformationKind =
    dependencies.modelTaskCompletedInformationKind;
  async function release(
    assistant: DeepReadonly<InformationAtom>,
    context: InformationModuleHandlerContext,
  ) {
    const assistantPayload = assistantTextInformationKind.payloadSchema.parse(
      assistant.payload,
    );
    if (assistantPayload.originatingModuleInstanceId !== context.instanceId)
      return;
    if (
      dependencies.messageAuthorizationCapability &&
      !(await context
        .use(dependencies.messageAuthorizationCapability)
        .stage(assistant))
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
                  informationId: assistantPayload.turn.claimInformationId,
                },
                {
                  relation: "agent:turn-candidate" as const,
                  informationId: assistantPayload.turn.candidateInformationId,
                },
              ],
      },
    );
  }
  return defineInformationModule({
    manifest: {
      protocolVersion: 1,
      moduleVersion: "1.0.0",
      selectors: [
        ...(dependencies.expressionEnabled ? [expressionDispatchSelector] : []),
        selector,
        ...(selector === currentAcceptedMessageSelector
          ? []
          : [currentAcceptedMessageSelector]),
        completedMessageSelector,
        confirmedAssistantSelector,
      ],
      promptRenderers: [
        messagePromptRenderer,
        memoryPromptRenderer,
        inboundMemoryPromptRenderer,
        assistantHistoryPromptRenderer,
      ],
      requires: [
        ...(dependencies.expressionEnabled ? [expressionReady] : []),
        modelTaskCapability,
        ...(dependencies.messageAuthorizationCapability
          ? [dependencies.messageAuthorizationCapability]
          : []),
      ],
      provides: [],
      definitionId: "agent.message-composer",
      inspection: firstPartyInspection["agent.message-composer"],
      displayName: "消息合成",
      summary: "根据显式选定的冻结上下文生成待投递正文。",
      description:
        "消费消息意图与模型结果，选择历史、记忆及当前输入并编译 Prompt，通过 Model Task 生成正文；输出助手消息与投递请求，跨会话正文需经宿主确认后释放。",
      settingsSchema: messageComposerSettingsSchema,
      promptTemplates: messageModulePromptTemplates,
      consumes: [
        userStatementInformationKind,
        ...(dependencies.expressionEnabled ? [expressionSelected] : []),
        messageConfirmedInformationKind,
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
          (dependencies.expressionEnabled
            ? expressionSelected
            : messageIntentRequestedInformationKind) as unknown as InformationKindDefinition<
            string,
            JsonObject
          >,
          {
            subscriptionId: dependencies.expressionEnabled
              ? "kaguya.message.expression-selected"
              : "kaguya.message.requested",
            delivery: "durable",
          },
          async (input, context) => {
            const selected = dependencies.expressionEnabled
              ? await context.select(expressionDispatchSelector)
              : [];
            const original = dependencies.expressionEnabled
              ? selected.find(
                  (a) => a.informationId === input.payload.intentInformationId,
                )!
              : input;
            const message = {
              ...original,
              payload: messageIntentRequestedInformationPayloadSchema.parse(
                original.payload,
              ),
            };
            const authorized = dependencies.messageAuthorizationCapability
              ? await context
                  .use(dependencies.messageAuthorizationCapability)
                  .prepare(message)
              : undefined;
            let contextAtoms =
              authorized?.contextAtoms ?? (await context.select(selector));
            const persistedIntent = requireSelectedMessageIntent(
              contextAtoms,
              message.informationId,
            );
            let prompt =
              authorized?.prompt ??
              compilePrompt(contextAtoms, persistedIntent.informationId);
            if (!authorized && dependencies.messageAuthorizationCapability) {
              const service = context.use(
                dependencies.messageAuthorizationCapability,
              );
              const turn = contextAtoms.find(
                (a) =>
                  a.informationId === message.payload.turn.contextInformationId,
              );
              if (service.conversation && turn) {
                const conversation = await service.conversation(turn);
                const background = JSON.stringify(
                  conversation.payload.background,
                );
                const suffix = renderBackground([
                  {
                    name: "conversation_background",
                    content: background,
                    informationIds: [conversation.informationId],
                  },
                ]);
                contextAtoms = [...contextAtoms, conversation];
                prompt = {
                  ...prompt,
                  text: prompt.text + suffix.text,
                  templates: [...prompt.templates, ...suffix.templates],
                  variables: [...prompt.variables, ...suffix.variables],
                };
              }
            }
            contextAtoms = [
              ...new Map(
                [...contextAtoms, ...selected].map((a) => [a.informationId, a]),
              ).values(),
            ];
            prompt = expressionPrompt(
              prompt,
              contextAtoms,
              message.informationId,
              renderHabits,
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
            await release(assistant, context);
          },
        ),
        onInformation(
          messageConfirmedInformationKind,
          { subscriptionId: "kaguya.message.confirmed", delivery: "durable" },
          async (_confirmed, context) => {
            const assistant = (
              await context.select(confirmedAssistantSelector)
            )[0];
            if (!assistant) throw new Error("target-authorization-required");
            await release(assistant, context);
          },
        ),
      ],
    }),
  });
}

/** 按共享声明编译可选上下文后缀；即使当前未启用该上下文，也在模块构造时拒绝无效模板。 */
function createContextPromptRenderer(
  templates: MessagePromptTemplates,
  key: "conversationBackground" | "expressionHabits",
) {
  const declaration = messageTemplateDeclarations.find(
    (candidate) => candidate.key === key,
  )!;
  return createPromptTemplateRenderer({
    kind: "message",
    templateId: `kaguya.message.${declaration.name}`,
    main: { ...declaration, content: templates[key] },
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

const confirmedAssistantSelector = defineInformationSelector({
  selectorId: "kaguya.message.confirmed-assistant",
  select: async ({ sourceAtom, ledger }) => {
    const payload = messageConfirmedInformationKind.payloadSchema.parse(
      sourceAtom.payload,
    );
    const atoms = await ledger.related({
      from: [sourceAtom.informationId],
      relation: "core:caused-by",
      direction: "outgoing",
      limit: 2,
    });
    if (
      atoms.length !== 1 ||
      atoms[0]!.kind !== assistantTextInformationKind.kind ||
      atoms[0]!.informationId !== payload.assistantInformationId
    )
      throw new Error("target-authorization-required");
    return [atoms[0]!.informationId];
  },
});
