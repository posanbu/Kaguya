/**
 * Heavy 根据冻结上下文逐段生成正文，每段成功投递后才创建下一步。
 * 接续绕过参与判断，保留原意图、原生模型历史、实际回执和新增消息。
 * 持久化 one-shot 计入模型耗时后安排短暂停顿，独立步骤键贯穿草稿、助手消息和投递。
 * QQ 可经独立表情处理器装饰。全部出站沿用宿主授权，跨会话批准仍仅发送一次。
 * 失败、预算受阻或投递未知交给 Router 记录，不能当作自然结束。
 */
import { firstPartyInspection } from "../inspection.js";
import {
  oneShotDueInformationKind,
  oneShotScheduleCapability,
} from "@kaguya/scheduler";
import {
  pacingSchema,
  speechReadyAt,
  speechReadyInformationKind,
  speechStepRequestedInformationKind,
  speechObservedInformationKind,
  speechStepContextSelector,
  speechDueSelector,
  speechDeliveredSelector,
  speechClosedSelector,
  appendSpeechContext,
} from "./speech.js";
import { appendNativeMemoryToPrompt } from "../memory-native/prompt.js";
import {
  heavyModulePromptTemplates,
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
  compiledPromptSchema,
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
  deliveryRequestedInformationKind,
  inboundTextInformationKind,
  messageIntentRequestedInformationKind,
  messageIntentRequestedInformationPayloadSchema,
  heavyResponseSilentInformationKind,
  type MessageIntentRequestedInformationPayload,
} from "../information-kinds.js";
import {
  inboundMemoryPromptRenderer,
  assistantHistoryPromptRenderer,
  messagePromptRenderer,
  currentAcceptedMessageSelector,
  turnMessageContextSelector,
} from "./message-context.js";
import {
  createMessagePromptCompiler,
  type AgentIdentity,
  type HeavyPromptTemplates,
} from "./message-prompt.js";

import {
  messageDraftInformationKind,
  messagePreparedInformationKind,
  messageDraftProcessorReady,
} from "../kinds/message.js";

export const modelTierSchema = z.enum(["light", "heavy"]);
export type ModelTier = z.infer<typeof modelTierSchema>;

export interface ModuleModelSelection {
  readonly modelTier: ModelTier;
}

export type { AgentIdentity, HeavyPromptTemplates } from "./message-prompt.js";

export const heavySettingsSchema = z
  .object({ pacing: pacingSchema.optional() })
  .strict();
export type HeavySettings = z.infer<typeof heavySettingsSchema>;

export const messageModelDispatchingDiagnostic = defineModuleDiagnostic({
  event: "heavy.model.dispatching",
  message: "Message model task dispatching",
  level: "info",
  payloadSchema: z
    .object({
      taskId: z.literal("agent.heavy.respond"),
      outputMode: z.enum(["text", "object"]),
      tier: z.literal("heavy"),
      promptCharacters: z.number().int().nonnegative(),
      promptVariableCount: z.number().int().nonnegative(),
      globalContextCharacters: z.number().int().nonnegative(),
      scopeContextCharacters: z.number().int().nonnegative(),
      memoryCharacters: z.number().int().nonnegative(),
    })
    .strict(),
  project: (payload) => ({ ...payload }),
});

export const messageTaskOutputSchema = z.string().trim().min(1);
export const messageResponseOutputSchema = z.union([
  z
    .object({
      action: z.literal("message"),
      text: z.string().trim().min(1),
      continuation: z.string().trim().min(1).nullable(),
    })
    .strict(),
  z
    .object({ action: z.literal("message"), text: z.string().trim().min(1) })
    .strict(),
  z.object({ action: z.literal("silent") }).strict(),
]);

export interface ModelTaskRequest<TOutput> {
  readonly task: {
    readonly taskId: string;
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
  readonly nativeContinuation?: boolean;
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
            | "task-schema-validation"
            | "context-budget"
            | "native-protocol";
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
  readonly sourceInformationId: string;
  readonly activation: {
    readonly instanceId: string;
    readonly definitionId: string;
  };
  readonly selectionPolicy: { readonly tier: "light" | "heavy" };
  readonly output: JsonValue;
};

export interface CreateHeavyModuleOptions<
  P extends ModelTaskCompletedInformationPayload =
    ModelTaskCompletedInformationPayload,
> {
  readonly modelTaskCapability: ModuleCapability<ModelTaskCapability>;
  readonly messageAuthorizationCapability?: ModuleCapability<MessageAuthorization>;
  readonly modelTaskCompletedInformationKind: InformationKindDefinition<
    "core.model.task.completed",
    P
  >;
  /** 装配时有独立展示插件才启用；本模块不决定表情策略。 */
  readonly draftProcessingEnabled?: boolean;
  readonly deliveryDeliveredInformationKind?: InformationKindDefinition<
    string,
    any
  >;
  readonly selector?: InformationSelectorDefinition;
  readonly promptTemplates: HeavyPromptTemplates;
  readonly agentIdentity: AgentIdentity;
}

export function createHeavyModule<
  P extends ModelTaskCompletedInformationPayload,
>(dependencies: CreateHeavyModuleOptions<P>) {
  const { modelTaskCapability } = dependencies;
  if (
    modelTaskCapability.id !== "kaguya:model-task" ||
    modelTaskCapability.apiVersion !== 1
  )
    throw new Error("Invalid model task capability");
  const baseSelector = dependencies.selector ?? turnMessageContextSelector;
  const selector = baseSelector;
  const compilePrompt = createMessagePromptCompiler(
    dependencies.promptTemplates,
    dependencies.agentIdentity,
  );
  const renderBackground = createContextPromptRenderer(
    dependencies.promptTemplates,
    "conversationBackground",
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
      "kaguya.heavy.delivery.v1",
      `${context.instanceId}:${assistant.informationId}`,
      deliveryRequestedInformationKind,
      {
        payload: {
          adapterId: assistantPayload.source.adapterId,
          platform: assistantPayload.source.platform,
          destination: assistantPayload.source.destination,
          message: {
            kind: "text",
            text: assistantPayload.text,
            ...(assistantPayload.expression
              ? { expression: assistantPayload.expression }
              : {}),
          },
          turn: assistantPayload.turn,
          ...(assistantPayload.speech
            ? { speech: assistantPayload.speech }
            : {}),
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
      category: "agent",
      protocolVersion: 1,
      moduleVersion: "1.0.0",
      selectors: [
        selector,
        ...(selector === currentAcceptedMessageSelector
          ? []
          : [currentAcceptedMessageSelector]),
        completedMessageSelector,
        confirmedAssistantSelector,
        speechStepContextSelector,
        speechDueSelector,
        speechDeliveredSelector,
        speechClosedSelector,
      ],
      promptRenderers: [
        messagePromptRenderer,
        inboundMemoryPromptRenderer,
        assistantHistoryPromptRenderer,
      ],
      requires: [
        ...(dependencies.draftProcessingEnabled
          ? [messageDraftProcessorReady]
          : []),
        modelTaskCapability,
        oneShotScheduleCapability,
        ...(dependencies.messageAuthorizationCapability
          ? [dependencies.messageAuthorizationCapability]
          : []),
      ],
      provides: [],
      definitionId: "agent.heavy",
      inspection: firstPartyInspection["agent.heavy"],
      displayName: "Heavy 正文生成",
      summary: "根据显式选定的冻结上下文生成待投递正文。",
      description:
        "消费消息意图与模型结果，选择历史、记忆及当前输入并编译 Prompt，通过 Model Task 生成正文；输出助手消息与投递请求，跨会话正文需经宿主确认后释放。",
      settingsSchema: heavySettingsSchema,
      promptTemplates: heavyModulePromptTemplates,
      consumes: [
        ...(dependencies.draftProcessingEnabled
          ? [messagePreparedInformationKind]
          : []),
        messageConfirmedInformationKind,
        messageIntentRequestedInformationKind,
        completedInformationKind,
        assistantTextInformationKind,
        inboundTextInformationKind,
        speechStepRequestedInformationKind,
        speechReadyInformationKind,
        oneShotDueInformationKind,
        ...(dependencies.deliveryDeliveredInformationKind
          ? [dependencies.deliveryDeliveredInformationKind]
          : []),
      ],
      produces: [
        heavyResponseSilentInformationKind,
        ...(dependencies.draftProcessingEnabled
          ? [messageDraftInformationKind]
          : []),
        assistantTextInformationKind,
        deliveryRequestedInformationKind,
        speechStepRequestedInformationKind,
        speechObservedInformationKind,
        speechReadyInformationKind,
      ],
      diagnostics: [messageModelDispatchingDiagnostic],
    },
    create: ({ activation, settings }) => ({
      provisions: [],
      describeStartup: () => ({
        summary: "Heavy pipeline ready",
        fields: {
          modelTier: "heavy",
        },
      }),
      subscriptions: [
        ...(dependencies.draftProcessingEnabled
          ? [
              onInformation(
                messagePreparedInformationKind,
                {
                  subscriptionId: "kaguya.heavy.prepared",
                  delivery: "durable",
                },
                async (prepared, context) => {
                  if (
                    prepared.payload.originatingModuleInstanceId !==
                    context.instanceId
                  )
                    return;
                  await context.registerOnce(
                    "kaguya.heavy.prepared-assistant",
                    prepared.informationId,
                    prepared.payload.speech
                      ? speechReadyInformationKind
                      : assistantTextInformationKind,
                    {
                      payload: assistantTextInformationKind.payloadSchema.parse(
                        prepared.payload,
                      ),
                    },
                  );
                },
              ),
            ]
          : []),
        onInformation(
          messageIntentRequestedInformationKind,
          {
            subscriptionId: "kaguya.heavy.requested",
            delivery: "durable",
          },
          async (input, context) => {
            const message = {
              ...input,
              payload: messageIntentRequestedInformationPayloadSchema.parse(
                input.payload,
              ),
            };
            const authorized = dependencies.messageAuthorizationCapability
              ? await context
                  .use(dependencies.messageAuthorizationCapability)
                  .prepare(message)
              : undefined;
            let contextAtoms =
              authorized?.contextAtoms ?? (await context.select(selector));
            const persisted = authorized
              ? undefined
              : contextAtoms.find(
                  (atom) =>
                    atom.kind === "core.model.task.requested" &&
                    atom.payload.taskId === "agent.heavy.respond" &&
                    (atom.payload.activation as any)?.instanceId ===
                      context.instanceId,
                );
            if (persisted) {
              const byId = new Map(
                contextAtoms.map((atom) => [atom.informationId, atom]),
              );
              contextAtoms = (
                persisted.payload.contextInformationIds as string[]
              ).map((id) => {
                const atom = byId.get(id);
                if (!atom) throw new Error("Missing persisted Heavy context");
                return atom;
              });
            }
            const persistedIntent = requireSelectedMessageIntent(
              contextAtoms,
              message.informationId,
            );
            let prompt =
              authorized?.prompt ??
              (persisted?.payload.prompt as unknown as
                CompiledPrompt | undefined) ??
              compilePrompt(contextAtoms, persistedIntent.informationId);
            if (
              !authorized &&
              !persisted &&
              dependencies.messageAuthorizationCapability
            ) {
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
            if (!persisted && !authorized)
              prompt = appendNativeMemoryToPrompt(
                prompt,
                contextAtoms,
                message.payload.turn.contextInformationId,
              );
            const contexts = persistedIntent.references.filter(
              (r) => r.relation === "core:context",
            );
            if (contexts.length !== 1)
              throw new Error("Message intent must have one context");
            const ordinaryReply = authorized === undefined;
            await context.report(messageModelDispatchingDiagnostic, {
              taskId: "agent.heavy.respond",
              outputMode: ordinaryReply ? "object" : "text",
              tier: "heavy",
              promptCharacters: Array.from(prompt.text).length,
              promptVariableCount: prompt.variables.length,
              globalContextCharacters: variableCharacters(
                prompt,
                "global_context",
              ),
              scopeContextCharacters: variableCharacters(
                prompt,
                "scope_context",
              ),
              memoryCharacters: variableCharacters(prompt, "memory"),
            });
            await context.use(modelTaskCapability).execute<unknown>({
              task: {
                taskId: "agent.heavy.respond",
                outputMode: ordinaryReply ? "object" : "text",
                outputSchema: ordinaryReply
                  ? messageResponseOutputSchema
                  : messageTaskOutputSchema,
                allowedTiers: ["heavy"],
              },
              sourceInformationId: persistedIntent.informationId,
              contextInformationId: contexts[0]!.informationId,
              activation,
              selectionPolicy: { tier: "heavy" },
              prompt,
              contextAtoms,
              nativeContinuation: ordinaryReply,
            });
          },
        ),
        onInformation(
          completedInformationKind,
          {
            subscriptionId: "kaguya.heavy.model-task-completed",
            delivery: "durable",
          },
          async (completed, context) => {
            if (
              completed.payload.taskId !== "agent.heavy.respond" ||
              completed.payload.activation.definitionId !==
                activation.definitionId ||
              completed.payload.selectionPolicy.tier !== "heavy"
            )
              return;
            const selected = await context.select(completedMessageSelector);
            const source = selected.find(
              (a) => a.informationId === completed.payload.sourceInformationId,
            )!;
            const step =
              source?.kind === speechStepRequestedInformationKind.kind
                ? speechStepRequestedInformationKind.payloadSchema.parse(
                    source.payload,
                  )
                : undefined;
            if (step && (await context.select(speechClosedSelector)).length)
              return;
            const message = requireSelectedMessageIntent(
              selected,
              step?.intentInformationId ??
                completed.payload.sourceInformationId,
            );
            if (step)
              await context.registerOnce(
                "kaguya.heavy.step.observed",
                source.informationId,
                speechObservedInformationKind,
                {
                  payload: {
                    stepInformationId: source.informationId,
                    scopeKey: step.scopeKey,
                    observedThroughInformationId:
                      step.observedThroughInformationId,
                    turn: step.turn,
                  },
                  references: [
                    {
                      relation: "core:uses-context",
                      informationId: source.informationId,
                    },
                  ],
                },
              );
            const response =
              completed.payload.outputMode === "object"
                ? messageResponseOutputSchema.parse(completed.payload.output)
                : {
                    action: "message" as const,
                    text: messageTaskOutputSchema.parse(
                      completed.payload.output,
                    ),
                  };
            if (response.action === "silent") {
              await context.registerOnce(
                "kaguya.heavy.silent.v1",
                `${context.instanceId}:${completed.informationId}`,
                heavyResponseSilentInformationKind,
                {
                  payload: {
                    intentInformationId: message.informationId,
                    turn: message.payload.turn,
                    ...(step
                      ? {
                          previousDeliveryInformationId:
                            step.previousDeliveryInformationId,
                        }
                      : {}),
                  },
                  references: [
                    {
                      relation: "core:uses-context",
                      informationId: message.informationId,
                    },
                    {
                      relation: "agent:turn-claim",
                      informationId: message.payload.turn.claimInformationId,
                    },
                    {
                      relation: "agent:turn-candidate",
                      informationId:
                        message.payload.turn.candidateInformationId,
                    },
                  ],
                },
              );
              return;
            }
            const requested = selected.find(
              (a) => a.kind === "core.model.task.requested",
            );
            const speech =
              "continuation" in response && requested
                ? {
                    intentInformationId: message.informationId,
                    stepInformationId: source.informationId,
                    stepIndex: step?.stepIndex ?? 0,
                    completedInformationId: completed.informationId,
                    continuation: z
                      .string()
                      .nullable()
                      .parse(response.continuation),
                    readyAt: speechReadyAt(
                      requested.occurredAt,
                      source.informationId,
                      response.text,
                      settings.pacing,
                    ),
                  }
                : undefined;
            await context.registerOnce(
              "kaguya.heavy.assistant.v1",
              `${context.instanceId}:${completed.informationId}`,
              dependencies.draftProcessingEnabled &&
                message.payload.target.platform === "qq"
                ? messageDraftInformationKind
                : speech
                  ? speechReadyInformationKind
                  : assistantTextInformationKind,
              {
                payload: {
                  text: response.text,
                  source: message.payload.target,
                  originatingModuleInstanceId: context.instanceId,
                  turn: message.payload.turn,
                  ...(speech ? { speech } : {}),
                },
              },
            );
          },
        ),
        onInformation(
          assistantTextInformationKind,
          { subscriptionId: "kaguya.heavy.assistant", delivery: "durable" },
          async (assistant, context) => {
            await release(assistant, context);
          },
        ),
        onInformation(
          messageConfirmedInformationKind,
          { subscriptionId: "kaguya.heavy.confirmed", delivery: "durable" },
          async (_confirmed, context) => {
            const assistant = (
              await context.select(confirmedAssistantSelector)
            )[0];
            if (!assistant) throw new Error("target-authorization-required");
            await release(assistant, context);
          },
        ),
        onInformation(
          speechReadyInformationKind,
          { subscriptionId: "kaguya.heavy.pacing", delivery: "durable" },
          async (ready, context) => {
            if (
              ready.payload.originatingModuleInstanceId !== context.instanceId
            )
              return;
            if (ready.payload.speech) {
              await context.use(oneShotScheduleCapability).schedule({
                operationKey: `heavy-speech:${context.instanceId}:${ready.informationId}`,
                sourceInformationId: ready.informationId,
                dueAt: ready.payload.speech.readyAt,
                activation,
                input: {
                  purpose: "heavy-speech",
                  readyInformationId: ready.informationId,
                },
              });
            } else
              await context.registerOnce(
                "kaguya.heavy.ready-assistant",
                ready.informationId,
                assistantTextInformationKind,
                { payload: ready.payload },
              );
          },
        ),
        onInformation(
          oneShotDueInformationKind,
          { subscriptionId: "kaguya.heavy.pacing-due", delivery: "durable" },
          async (due, context) => {
            const atoms = await context.select(speechDueSelector);
            const ready = atoms.find(
              (a) => a.kind === speechReadyInformationKind.kind,
            );
            if (
              !ready ||
              ready.payload.originatingModuleInstanceId !== context.instanceId
            )
              return;
            const runtime = atoms.find(
              (a) => a.kind === "core.runtime.context",
            )!;
            if ((await context.select(speechClosedSelector)).length) {
              await context.use(oneShotScheduleCapability).finish({
                scheduleInformationId: due.payload.scheduleInformationId,
                status: "fired",
              });
              return;
            }
            await context.registerOnce(
              "kaguya.heavy.ready-assistant",
              ready.informationId,
              assistantTextInformationKind,
              {
                payload: assistantTextInformationKind.payloadSchema.parse(
                  ready.payload,
                ),
                contextInformationId: runtime.informationId,
                references: [
                  {
                    relation: "core:uses-context",
                    informationId: ready.informationId,
                  },
                ],
              },
            );
            await context.use(oneShotScheduleCapability).finish({
              scheduleInformationId: due.payload.scheduleInformationId,
              status: "fired",
            });
          },
        ),
        ...(dependencies.deliveryDeliveredInformationKind
          ? [
              onInformation(
                dependencies.deliveryDeliveredInformationKind,
                {
                  subscriptionId: "kaguya.heavy.delivered",
                  delivery: "durable",
                },
                async (delivered, context) => {
                  const atoms = await context.select(speechDeliveredSelector);
                  const deliveryId = delivered.references.find(
                    (r) => r.relation === "core:status-of",
                  )?.informationId;
                  const delivery = atoms.find(
                    (a) => a.informationId === deliveryId,
                  );
                  if (!delivery) return;
                  if ((await context.select(speechClosedSelector)).length)
                    return;
                  const speech =
                    deliveryRequestedInformationKind.payloadSchema.parse(
                      delivery.payload,
                    ).speech!;
                  const previous = atoms.find(
                    (a) => a.informationId === speech.completedInformationId,
                  )!;
                  if (
                    (previous.payload.activation as { instanceId: string })
                      .instanceId !== context.instanceId
                  )
                    return;
                  const root = requireSelectedMessageIntent(
                    atoms,
                    speech.intentInformationId,
                  );
                  const priorSource = atoms.find(
                    (a) => a.informationId === speech.stepInformationId,
                  )!;
                  const turn = atoms.find(
                    (a) =>
                      a.informationId ===
                      root.payload.turn.contextInformationId,
                  )!;
                  const previousRequest = atoms.find(
                    (a) =>
                      a.informationId ===
                      previous.references.find(
                        (r) => r.relation === "core:caused-by",
                      )!.informationId,
                  )!;
                  const rootRequest = atoms.find(
                    (a) =>
                      a.kind === "core.model.task.requested" &&
                      a.payload.sourceInformationId === root.informationId,
                  )!;
                  const knownIds = new Set(
                    previousRequest.payload.contextInformationIds as string[],
                  );
                  const incoming = atoms.filter(
                    (a) =>
                      a.kind === inboundTextInformationKind.kind &&
                      !knownIds.has(a.informationId),
                  );
                  const originalIds = new Set(
                    rootRequest.payload.contextInformationIds as string[],
                  );
                  const interjections = atoms.filter(
                    (a) =>
                      a.kind === inboundTextInformationKind.kind &&
                      !originalIds.has(a.informationId),
                  );
                  const through =
                    incoming.at(-1)?.informationId ??
                    String(
                      priorSource.payload.observedThroughInformationId ??
                        turn.payload.observedThroughInformationId,
                    );
                  const content = JSON.stringify({
                    continuation: speech.continuation,
                    delivered: atoms
                      .filter(
                        (a) =>
                          a.kind === "core.delivery.requested" &&
                          (
                            a.payload.speech as
                              { intentInformationId?: string } | undefined
                          )?.intentInformationId === root.informationId,
                      )
                      .map((a) => ({
                        step: a.payload.speech,
                        message: a.payload.message,
                        receipt: atoms.find(
                          (r) =>
                            r.kind === "core.delivery.delivered" &&
                            r.references.some(
                              (ref) =>
                                ref.relation === "core:status-of" &&
                                ref.informationId === a.informationId,
                            ),
                        )?.payload,
                      })),
                    newMessages: incoming.map((a) => ({
                      id: a.informationId,
                      at: a.occurredAt,
                      ...a.payload,
                    })),
                    earlierInterjections: interjections
                      .filter((a) => knownIds.has(a.informationId))
                      .map((a) => ({
                        id: a.informationId,
                        at: a.occurredAt,
                        ...a.payload,
                      })),
                  });
                  const ids = atoms.map((a) => a.informationId);
                  await context.registerOnce(
                    "kaguya.heavy.step",
                    `${context.instanceId}:${delivered.informationId}`,
                    speechStepRequestedInformationKind,
                    {
                      payload:
                        speechStepRequestedInformationKind.payloadSchema.parse({
                          ...root.payload,
                          intentInformationId: root.informationId,
                          stepIndex: speech.stepIndex + 1,
                          continuation: speech.continuation!,
                          previousDeliveryInformationId:
                            delivered.informationId,
                          observedThroughInformationId: through,
                          scopeKey: String(turn.payload.scopeKey),
                          contextInformationIds: ids,
                          prompt: appendSpeechContext(
                            compiledPromptSchema.parse(
                              rootRequest.payload.prompt,
                            ),
                            content,
                            ids,
                          ),
                        }),
                      references: ids.map((informationId) => ({
                        relation: "core:uses-context",
                        informationId,
                      })),
                    },
                  );
                },
              ),
            ]
          : []),
        onInformation(
          speechStepRequestedInformationKind,
          { subscriptionId: "kaguya.heavy.step", delivery: "durable" },
          async (step, context) => {
            if ((await context.select(speechClosedSelector)).length) return;
            const atoms = await context.select(speechStepContextSelector);
            const rootRequest = atoms.find(
              (a) =>
                a.kind === "core.model.task.requested" &&
                a.payload.sourceInformationId ===
                  step.payload.intentInformationId,
            )!;
            if (
              (rootRequest.payload.activation as { instanceId: string })
                .instanceId !== context.instanceId
            )
              return;
            await context.use(modelTaskCapability).execute({
              task: {
                taskId: "agent.heavy.respond",
                outputMode: "object",
                outputSchema: messageResponseOutputSchema,
                allowedTiers: ["heavy"],
              },
              sourceInformationId: step.informationId,
              contextInformationId: step.references.find(
                (r) => r.relation === "core:context",
              )!.informationId,
              activation,
              selectionPolicy: { tier: "heavy" },
              prompt: compiledPromptSchema.parse(step.payload.prompt),
              contextAtoms: atoms,
              nativeContinuation: true,
            });
          },
        ),
      ],
    }),
  });
}

/** 按共享声明编译可选上下文后缀；即使当前未启用该上下文，也在模块构造时拒绝无效模板。 */
function createContextPromptRenderer(
  templates: HeavyPromptTemplates,
  key: "conversationBackground",
) {
  const declaration = messageTemplateDeclarations.find(
    (candidate) => candidate.key === key,
  )!;
  return createPromptTemplateRenderer({
    kind: "message",
    templateId: `kaguya.heavy.${declaration.name}`,
    main: { ...declaration, content: templates[key] },
  });
}

const completedMessageSelector = defineInformationSelector({
  selectorId: "kaguya.heavy.completed-source",
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
      (message?.kind !== messageIntentRequestedInformationKind.kind &&
        message?.kind !== speechStepRequestedInformationKind.kind) ||
      message.informationId !== payload.sourceInformationId
    )
      throw new Error(
        "Model task completion source must match its message intent cause",
      );
    if (message.kind === speechStepRequestedInformationKind.kind)
      await ledger.find({
        informationIds: [String(message.payload.intentInformationId)],
        limit: 1,
      });
    return [
      message.informationId,
      requested[0]!.informationId,
      ...(message.kind === speechStepRequestedInformationKind.kind
        ? [String(message.payload.intentInformationId)]
        : []),
    ];
  },
});

function requireSelectedMessageIntent(
  atoms: readonly DeepReadonly<InformationAtom>[],
  informationId: string,
): DeepReadonly<
  InformationAtom<
    "agent.router.message.intent.requested",
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
      "agent.router.message.intent.requested",
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
  selectorId: "kaguya.heavy.confirmed-assistant",
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
