/**
 * prepareMedia 仅对尚未登记的新 Heavy 请求执行；媒体实际消息随 requested 保存，恢复不重新读取素材。
 * 原生步骤核对冻结模型配置；历史 GUI 回执经共享投影读取原始归档图，缺失或失配时不派发模型。
 * 功能概述：提供模块可声明的通用模型任务能力，任务 ID 及输出 schema 由调用方拥有。
 * 主要职责：modelTaskCapability 是版本化 token；ModelTaskClient.execute 重载 selected atoms、
 * 校验 Prompt provenance 并以规范 JSON 摘要 registerOnce，随后复用或竞争唯一终态；cancel
 * 是唯一业务取消入口，任意 reason 仅持久化固定安全说明。ModelTaskResult 仅返回赢家及校验后输出。
 * 代码库关系：组合层注入 Core、KaguyaLlmClient.generate 与 tier 模型解析器；SDK 使用
 * { capability: modelTaskCapability, value: client } 提供能力。Core.withClaim 的异步上下文隐式
 * 传递 executionSignal/fencing；本层不取得或伪造 claim，不修改 Runtime 或业务模块。
 * 输入输出与副作用：requested 保存 prompt 与来源，终态保存元数据、usage/duration 和安全错误。
 * shutdown/lease abort 只中断执行，不能产生 cancelled；commitTerminal 决定唯一赢家。不同并发
 * 执行和崩溃恢复仍可能重复外部调用，本层保证事实唯一而不承诺 provider exactly-once。
 * 重放先按指纹读取 requested/terminal，不依赖模型 resolver；新请求仍只经 registerOnce 写入。
 * provider 仅校验由任务输入导出的无 transform schema；本层唯一执行任务 parse/transform，
 * 再检查 JSON 与 informationPayloadSchema。重放不执行任务 transform，存储/fencing 异常不转业务失败。
 * 工具模式保存单次 dispatch 身份，工具调用不走业务输出 schema；恢复未确认请求时不重复请求。
 * LLM 边界内重试仍只提交一个终态；失败只保存受控结构化分类、Provider 诊断与尝试次数。
 * readFailureMetrics/readProviderFailure 对跨边界值再次校验，非法指标或诊断不会阻断失败终态提交。
 */
import { createHash, randomUUID } from "node:crypto";
import {
  planNativeToolResults,
  type NativeToolResultPlan,
  type NativeArtifactReader,
} from "./native-tool-results.js";
import { assembleNativeInputWithArtifacts } from "./native-input.js";
import { InformationCore } from "@kaguya/engine";
import { KaguyaLlmError, type KaguyaLlmClient } from "@kaguya/llm/client";
import type { StructuredOutputPromptRenderer } from "@kaguya/llm";
import {
  type CompiledPrompt,
  type DeepReadonly,
  type InformationAtom,
  type JsonValue,
  jsonValueSchema,
  informationPayloadSchema,
  nativeMessagesSchema,
  nativeResponseSchema,
  type NativeMessage,
  type NativeResponse,
  nativeToolDeclarationSchema,
  type NativeToolDeclaration,
  type NativeToolCall,
  z,
} from "@kaguya/schema";
import {
  defineModuleCapability,
  type ModuleActivationProvenance,
} from "@kaguya/sdk";
import {
  informationCompiledPromptSchema,
  modelTaskMetadataSchema,
  nativeModelBindingSchema,
  modelTaskContextTrimmingSchema,
  modelTaskResolvedModelSchema,
  modelTaskSelectionPolicySchema,
  modelTaskRequestedInformationKind,
  modelTaskDispatchedInformationKind,
  modelTaskCompletedInformationKind,
  modelTaskFailedInformationKind,
  modelTaskCancelledInformationKind,
  modelTaskSafeErrorSchema,
  modelTaskProviderFailureSchema,
  modelTaskProviderReasonSchema,
  modelTaskProviderStatusCodeSchema,
  modelTaskProviderCodeSchema,
  modelTaskProviderTypeSchema,
} from "./information-kinds.js";

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
  readonly selectionPolicy: z.infer<typeof modelTaskSelectionPolicySchema>;
  readonly prompt: CompiledPrompt;
  readonly contextAtoms: readonly DeepReadonly<InformationAtom>[];
  readonly messages?: NativeMessage[];
  readonly nativeContinuation?: boolean;
  readonly tools?: readonly NativeToolDeclaration[];
  readonly contextTrimming?: z.infer<typeof modelTaskContextTrimmingSchema>;
  readonly nativeModelBinding?: z.infer<typeof nativeModelBindingSchema>;
  readonly nativeStep?: {
    runInformationId: string;
    stepIndex: number;
    deadline: string;
    maxContextBytes: number;
    maxOutputBytes: number;
  };
}
type ResultIdentity = {
  readonly requestedInformationId: string;
  readonly terminalInformationId: string;
};
export type ModelTaskResult<TOutput> = ResultIdentity &
  (
    | {
        readonly status: "completed";
        readonly output: TOutput;
        readonly native?: NativeResponse;
      }
    | {
        readonly status: "tool-calls";
        readonly native: NativeResponse;
        readonly calls: NativeToolCall[];
      }
    | {
        readonly status: "failed";
        readonly error: z.infer<typeof modelTaskSafeErrorSchema>;
      }
    | {
        readonly status: "cancelled";
        readonly reason: "Explicit cancellation requested";
      }
  );
export interface ModelTaskCancellation {
  readonly requestedInformationId: string;
  readonly reason: string;
}
export interface ModelTaskCapability {
  execute<TOutput>(
    request: ModelTaskRequest<TOutput>,
  ): Promise<ModelTaskResult<TOutput>>;
  cancel(request: ModelTaskCancellation): Promise<ModelTaskResult<unknown>>;
}
export const modelTaskCapability = defineModuleCapability<ModelTaskCapability>(
  "kaguya:model-task",
  1,
);
export interface ModelTaskClientOptions {
  readonly core: InformationCore;
  readonly client: Pick<KaguyaLlmClient, "generate">;
  readonly resolveModel: (
    policy: z.infer<typeof modelTaskSelectionPolicySchema>,
  ) => z.infer<typeof modelTaskResolvedModelSchema>;
  readonly now?: () => Date;
  readonly renderStructuredOutputPrompt: StructuredOutputPromptRenderer;
  readonly prepareMedia?: (
    key: string,
    request: ModelTaskRequest<unknown>,
    model: { providerId: string; modelId: string },
  ) => Promise<NativeMessage[]>;
  readonly readNativeArtifact?: NativeArtifactReader;
  readonly beforeAttempt?: (
    requestedInformationId: string,
    activation: ModuleActivationProvenance,
    taskId: string,
    attempt: number,
    invocationId: string,
  ) => Promise<void>;
  readonly admitNativeDispatch?: (
    requestedInformationId: string,
    step: NonNullable<ModelTaskRequest<unknown>["nativeStep"]>,
  ) => Promise<boolean>;
}
const terminalGroup = "kaguya.model.task.result";
type Requested = DeepReadonly<
  InformationAtom<
    "core.model.task.requested",
    z.infer<typeof modelTaskRequestedInformationKind.payloadSchema>
  >
>;

export class ModelTaskClient implements ModelTaskCapability {
  readonly #core: InformationCore;
  readonly #client: Pick<KaguyaLlmClient, "generate">;
  readonly #prepareMedia: ModelTaskClientOptions["prepareMedia"];
  readonly #readNativeArtifact: NativeArtifactReader | undefined;
  readonly #resolveModel: ModelTaskClientOptions["resolveModel"];
  readonly #now: () => Date;
  readonly #renderStructuredOutputPrompt: StructuredOutputPromptRenderer;
  readonly #admitNativeDispatch: ModelTaskClientOptions["admitNativeDispatch"];
  readonly #beforeAttempt: ModelTaskClientOptions["beforeAttempt"];
  readonly #inflight = new Map<string, Set<AbortController>>();
  constructor(options: ModelTaskClientOptions) {
    this.#core = options.core;
    this.#prepareMedia = options.prepareMedia;
    this.#admitNativeDispatch = options.admitNativeDispatch;
    this.#beforeAttempt = options.beforeAttempt;
    this.#client = options.client;
    this.#resolveModel = options.resolveModel;
    this.#readNativeArtifact = options.readNativeArtifact;
    this.#now = options.now ?? (() => new Date());
    this.#renderStructuredOutputPrompt = options.renderStructuredOutputPrompt;
  }

  async execute<TOutput>(
    request: ModelTaskRequest<TOutput>,
  ): Promise<ModelTaskResult<TOutput>> {
    try {
      return await this.executeInternal(request);
    } catch {
      throw new Error("Model task execution could not be committed");
    }
  }

  private async executeInternal<TOutput>(
    request: ModelTaskRequest<TOutput>,
  ): Promise<ModelTaskResult<TOutput>> {
    const task = request.task;
    if (!(task.outputSchema instanceof z.ZodType))
      throw new Error("Invalid task schema");
    const selectionPolicy = modelTaskSelectionPolicySchema.parse(
      request.selectionPolicy,
    );
    const allowed = z
      .array(z.enum(["light", "heavy"]))
      .min(1)
      .parse(task.allowedTiers);
    if (!allowed.includes(selectionPolicy.tier))
      throw new Error("Disallowed model tier");
    const inputJsonSchema =
      task.outputMode === "object"
        ? z.toJSONSchema(task.outputSchema, { io: "input" })
        : undefined;
    const renderedPrompt =
      inputJsonSchema === undefined
        ? request.prompt
        : this.#renderStructuredOutputPrompt(request.prompt, inputJsonSchema);
    const prompt = informationCompiledPromptSchema.parse(renderedPrompt);
    // The final user message is the audited, schema-enriched current prompt.
    let messages =
      request.messages === undefined
        ? undefined
        : nativeMessagesSchema.parse([
            ...request.messages,
            { role: "user", content: prompt.text },
          ]);
    if (request.contextTrimming) {
      const trimming = modelTaskContextTrimmingSchema.parse(
        request.contextTrimming,
      );
      if (
        !request.messages ||
        trimming.retainedBytes !==
          Buffer.byteLength(JSON.stringify(request.messages)) ||
        trimming.retainedBytes > trimming.budgetBytes ||
        trimming.originalBytes < trimming.retainedBytes ||
        trimming.truncated !== trimming.omittedSegments > 0
      )
        throw new Error("Invalid native context trimming metadata");
    }
    const metadata = modelTaskMetadataSchema
      .omit({ resolvedModel: true })
      .parse({
        taskId: task.taskId,
        outputMode: task.outputMode,
        sourceInformationId: request.sourceInformationId,
        contextInformationId: request.contextInformationId,
        contextInformationIds: request.contextAtoms.map((a) => a.informationId),
        activation: request.activation,
        selectionPolicy,
        promptKind: prompt.kind,
        promptTemplateId: prompt.templateId,
        promptTemplateDigest: prompt.templateDigest,
        promptDigest: prompt.promptDigest,
        messagesDigest: messages ? digest(canonical(messages)) : null,
        provenance: prompt.provenance,
        ...(request.tools ? { tools: request.tools } : {}),
        ...(request.contextTrimming
          ? { contextTrimming: request.contextTrimming }
          : {}),
        ...(request.nativeStep ? { nativeStep: request.nativeStep } : {}),
        ...(request.nativeModelBinding
          ? { nativeModelBinding: request.nativeModelBinding }
          : {}),
      });
    const selected = await this.#core.getMany(metadata.contextInformationIds);
    if (
      selected.length !== request.contextAtoms.length ||
      selected.some(
        (a, i) => canonical(a) !== canonical(request.contextAtoms[i]),
      )
    )
      throw new Error("Selected atoms must match the ledger in order");
    const selectedIds = new Set(metadata.contextInformationIds);
    const provenanceIds = prompt.provenance.flatMap(
      ({ informationIds }) => informationIds,
    );
    if (provenanceIds.some((informationId) => !selectedIds.has(informationId)))
      throw new Error("Prompt provenance must reference selected information");
    if (
      prompt.variables.length !== prompt.provenance.length ||
      prompt.variables.some((variable, i) => {
        const p = prompt.provenance[i]!;
        return (
          variable.name !== p.variableName ||
          canonical(variable.informationIds) !== canonical(p.informationIds) ||
          digest(variable.content) !== p.contentDigest
        );
      })
    )
      throw new Error("Invalid Prompt provenance");
    const source = selected.find(
      (a) => a.informationId === metadata.sourceInformationId,
    )!;
    const contexts = source.references.filter(
      (r) => r.relation === "core:context",
    );
    if (
      contexts.length !== 1 ||
      contexts[0]!.informationId !== metadata.contextInformationId
    )
      throw new Error("Invalid source context");
    const key = modelTaskFingerprint(metadata);
    let requested = await this.readRequested(metadata.sourceInformationId, key);
    if (requested) {
      const terminal = await this.readTerminal(requested.informationId);
      if (terminal)
        return resultFromWinner<TOutput>(terminal, requested.informationId);
    }
    // 输入 JSON schema 不包含任务 transform；真实 client 在此边界只产生未转换输入。
    const providerSchema =
      inputJsonSchema === undefined
        ? task.outputSchema
        : z.fromJSONSchema(inputJsonSchema);
    const resolvedModel = requested
      ? undefined
      : modelTaskResolvedModelSchema.parse(this.#resolveModel(selectionPolicy));
    let inputBlocked: "context-budget" | "native-protocol" | null = null;
    if (!requested && request.nativeContinuation) {
      if (messages)
        throw new Error(
          "Explicit messages and continuation are mutually exclusive",
        );
      try {
        const toolPlans = new Map<string, NativeToolResultPlan>();
        for (const completed of selected) {
          const p = completed.payload as any;
          if (
            completed.kind !== "core.model.task.completed" ||
            p.taskId !== task.taskId ||
            p.activation?.instanceId !== request.activation.instanceId ||
            p.generationKind !== "tool-calls"
          )
            continue;
          if (canonical(p.resolvedModel) !== canonical(resolvedModel)) continue;
          const ordered = (p.toolCalls ?? []).map((c: any) => ({
            call: c,
            result: selected.find(
              (a) =>
                a.kind === "agent.heavy.tool.result.v1" &&
                a.payload.modelCompletedInformationId ===
                  completed.informationId &&
                a.payload.toolCallId === c.toolCallId,
            ),
          }));
          if (
            ordered.some((r: any) => !r.result) ||
            !ordered.some((r: any) => r.result.payload.value?.result?.image)
          )
            continue;
          const currentRun = request.nativeStep
            ? await this.#core.get(request.nativeStep.runInformationId)
            : undefined;
          const currentScope = (currentRun?.payload.spec as any)?.scope;
          if (!currentScope) throw new Error("NATIVE_TOOL_INTERACTION_OPEN");
          const entries = await Promise.all(
            ordered.map(async ({ call, result }: any) => {
              const run = await this.#core.get(result.payload.runInformationId);
              const spec = run?.payload.spec as any;
              if (spec?.scope !== currentScope)
                throw new Error("NATIVE_TOOL_INTERACTION_OPEN");
              return {
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                toolId:
                  spec.declarations.find(
                    (d: any) => d.wireName === call.toolName,
                  )?.id ?? "",
                intentId: result.payload.intentId,
                scope: spec.scope,
                value: result.payload.value,
              };
            }),
          );
          toolPlans.set(
            completed.informationId,
            planNativeToolResults(entries),
          );
        }
        messages = await assembleNativeInputWithArtifacts({
          toolPlans,
          ...(this.#readNativeArtifact
            ? { readArtifact: this.#readNativeArtifact }
            : {}),
          prompt: prompt.text,
          atoms: selected,
          taskId: task.taskId,
          instanceId: request.activation.instanceId,
          model: resolvedModel!,
          maxBytes: request.nativeStep?.maxContextBytes ?? 128_000,
        });
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        if (error.message === "SITUATION_CONTEXT_BUDGET_EXCEEDED")
          inputBlocked = "context-budget";
        else if (
          error.message === "NATIVE_TOOL_INTERACTION_OPEN" ||
          error.message.startsWith("native-image-")
        )
          inputBlocked = "native-protocol";
        else throw error;
      }
    }
    let mediaInputByteLength = 0;
    if (
      !requested &&
      !inputBlocked &&
      selectionPolicy.tier === "heavy" &&
      this.#prepareMedia
    ) {
      try {
        const media = await this.#prepareMedia(key, request, resolvedModel!);
        if (media.length) {
          mediaInputByteLength = Buffer.byteLength(JSON.stringify(media));
          if (mediaInputByteLength > 30 * 1024 * 1024)
            throw new Error("SITUATION_CONTEXT_BUDGET_EXCEEDED");
          messages = nativeMessagesSchema.parse([
            ...(messages ?? [{ role: "user", content: prompt.text }]),
            ...media,
          ]);
        }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "media-native-model-unapproved"
        )
          inputBlocked = "native-protocol";
        else if (
          error instanceof Error &&
          error.message === "SITUATION_CONTEXT_BUDGET_EXCEEDED"
        ) {
          inputBlocked = "context-budget";
          mediaInputByteLength = 0;
        } else throw error;
      }
    }
    requested ??= await this.#core.registerOnce(
      "kaguya.model.task.requested",
      key,
      modelTaskRequestedInformationKind,
      {
        occurredAt: this.#now().toISOString(),
        source: "runtime:model-task",
        payload: {
          ...metadata,
          prompt,
          resolvedModel: resolvedModel!,
          messages: messages ?? null,
          ...(mediaInputByteLength ? { mediaInputByteLength } : {}),
          inputBlocked,
        },
        references: [
          {
            relation: "core:caused-by",
            informationId: metadata.sourceInformationId,
          },
          {
            relation: "core:context",
            informationId: metadata.contextInformationId,
          },
          ...metadata.contextInformationIds.map((informationId) => ({
            relation: "core:uses-context",
            informationId,
          })),
        ],
      },
    );
    const existing = await this.readTerminal(requested.informationId);
    if (existing)
      return resultFromWinner<TOutput>(existing, requested.informationId);
    const controller = new AbortController();
    const controllers =
      this.#inflight.get(requested.informationId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.#inflight.set(requested.informationId, controllers);
    const persisted = persistedMetadata(requested);
    const startedAt = this.#now().getTime();
    let metrics:
      { durationMs: number; usage?: Record<string, number> } | undefined;
    let failureReasonCode: "dispatched-without-terminal" | undefined;
    let failureStage:
      | "provider-request"
      | "structured-output-parse"
      | "task-schema-validation"
      | "context-budget"
      | "native-protocol" = "provider-request";
    let completed: z.infer<
      typeof modelTaskCompletedInformationKind.payloadSchema
    >;
    try {
      const lateTerminal = await this.readTerminal(requested.informationId);
      if (lateTerminal)
        return resultFromWinner<TOutput>(lateTerminal, requested.informationId);
      if (
        canonical(persisted.resolvedModel) !==
        canonical(
          resolvedModel ??
            modelTaskResolvedModelSchema.parse(
              this.#resolveModel(selectionPolicy),
            ),
        )
      )
        throw new Error("Recorded model unavailable");
      const executionSignal = this.#core.executionSignal;
      const signal = executionSignal
        ? AbortSignal.any([executionSignal, controller.signal])
        : controller.signal;
      if (
        request.nativeStep &&
        (!request.nativeModelBinding ||
          canonical(request.nativeModelBinding.selectionPolicy) !==
            canonical(persisted.selectionPolicy) ||
          canonical(request.nativeModelBinding.resolvedModel) !==
            canonical(persisted.resolvedModel))
      )
        throw new Error("Native model binding unavailable");
      if (requested.payload.inputBlocked) {
        failureStage = requested.payload.inputBlocked;
        throw new Error("Native input blocked");
      }
      if (requested.payload.tools) {
        if (requested.payload.nativeStep) {
          if (
            Date.parse(requested.payload.nativeStep.deadline) <=
            this.#now().getTime()
          )
            throw new Error("Native deadline exhausted");
          if (
            Buffer.byteLength(
              JSON.stringify({
                model: requested.payload.resolvedModel.modelId,
                messages: requested.payload.messages ?? [
                  { role: "user", content: prompt.text },
                ],
                tools: requested.payload.tools!.map((t) => ({
                  type: "function",
                  function: {
                    name: t.wireName,
                    description: t.description,
                    parameters: t.inputSchema,
                  },
                })),
                tool_choice: "auto",
              }),
            ) >
            requested.payload.nativeStep.maxContextBytes +
              (requested.payload.mediaInputByteLength ?? 0)
          ) {
            failureStage = "context-budget";
            throw new Error("Native input budget exhausted");
          }
        }
        const allowed =
          requested.payload.nativeStep && this.#admitNativeDispatch
            ? await this.#admitNativeDispatch(
                requested.informationId,
                requested.payload.nativeStep,
              )
            : await (async () => {
                const nonce = randomUUID();
                const dispatched = await this.#core.registerOnce(
                  "kaguya.model.dispatch",
                  requested.informationId,
                  modelTaskDispatchedInformationKind,
                  {
                    occurredAt: this.#now().toISOString(),
                    source: "runtime:model-task",
                    payload: {
                      requestedInformationId: requested.informationId,
                      nonce,
                    },
                    references: [
                      {
                        relation: "core:caused-by",
                        informationId: requested.informationId,
                      },
                    ],
                  },
                );
                return dispatched.payload.nonce === nonce;
              })();
        if (!allowed) {
          const winner = await this.readTerminal(requested.informationId);
          if (winner)
            return resultFromWinner<TOutput>(winner, requested.informationId);
          failureStage = "native-protocol";
          failureReasonCode = "dispatched-without-terminal";
          throw new Error(
            "Native request outcome unknown; automatic retry denied",
          );
        }
      }
      const invocationId = randomUUID();
      const generation = await this.#client.generate({
        ...(this.#beforeAttempt
          ? {
              beforeAttempt: (attempt: number) =>
                this.#beforeAttempt!(
                  requested.informationId,
                  persisted.activation,
                  persisted.taskId,
                  attempt,
                  invocationId,
                ),
            }
          : {}),
        modelId: persisted.resolvedModel.modelId,
        ...(requested.payload.messages
          ? { messages: nativeMessagesSchema.parse(requested.payload.messages) }
          : {
              prompt: informationCompiledPromptSchema.parse(
                requested.payload.prompt,
              ),
            }),
        ...(requested.payload.tools
          ? {
              tools: requested.payload.tools.map((t) =>
                nativeToolDeclarationSchema.parse(t),
              ),
            }
          : {}),
        ...(requested.payload.nativeStep
          ? {
              maxInputBytes:
                requested.payload.nativeStep.maxContextBytes +
                (requested.payload.mediaInputByteLength ?? 0),
              timeoutMs: Math.min(
                300000,
                Math.max(
                  1,
                  Date.parse(requested.payload.nativeStep.deadline) -
                    this.#now().getTime(),
                ),
              ),
            }
          : {}),
        outputMode: persisted.outputMode,
        outputSchema: providerSchema,
        ...(signal ? { signal } : {}),
      });
      const candidateMetrics = {
        durationMs: z.number().nonnegative().parse(generation.durationMs),
        ...(generation.usage === undefined
          ? {}
          : {
              usage: z
                .record(z.string(), z.number().nonnegative())
                .parse(generation.usage),
            }),
      };
      informationPayloadSchema.parse(candidateMetrics);
      metrics = candidateMetrics;
      failureStage = "task-schema-validation";
      const output =
        generation.kind === "tool-calls"
          ? null
          : jsonValueSchema.parse(
              await task.outputSchema.parseAsync(generation.output),
            );
      completed = modelTaskCompletedInformationKind.payloadSchema.parse({
        ...persisted,
        output,
        generationKind: generation.kind ?? "final",
        toolCalls: generation.kind === "tool-calls" ? generation.calls : [],
        ...(generation.native
          ? { native: nativeResponseSchema.parse(generation.native) }
          : {}),
        ...metrics,
      });
      // 与 Core 的 atom payload 使用同一边界：账本受限标识字段属于输出失败。
      // 真正 commit 留在此 try 外，数据库故障、关闭及 claim fencing 不生成 failed。
      informationPayloadSchema.parse(completed);
      if (
        requested.payload.nativeStep &&
        Buffer.byteLength(JSON.stringify(completed)) >
          requested.payload.nativeStep.maxOutputBytes
      ) {
        failureStage = "context-budget";
        throw new Error("Native output budget exhausted");
      }
    } catch (error) {
      if (this.#core.executionSignal?.aborted || controller.signal.aborted) {
        const winner = await this.readTerminal(requested.informationId);
        if (winner)
          return resultFromWinner<TOutput>(winner, requested.informationId);
        throw new Error("Model task execution interrupted");
      }
      const llmError = error instanceof KaguyaLlmError ? error : undefined;
      const winner = await this.#core.commitTerminal(
        terminalGroup,
        requested.informationId,
        modelTaskFailedInformationKind,
        {
          ...this.terminalInput(requested),
          payload: {
            ...persisted,
            ...(metrics ??
              readFailureMetrics(
                llmError,
                Math.max(0, this.#now().getTime() - startedAt),
              )),
            error: {
              name: "ModelTaskError",
              kind:
                error instanceof KaguyaLlmError && error.kind === "retryable"
                  ? "retryable"
                  : "non-retryable",
              stage:
                error instanceof KaguyaLlmError
                  ? (error.stage ?? failureStage)
                  : failureStage,
              message: "Model task generation failed",
              ...(failureReasonCode ? { reasonCode: failureReasonCode } : {}),
              ...(llmError?.structuredOutputFailure === undefined
                ? {}
                : {
                    structuredOutputFailure: llmError.structuredOutputFailure,
                  }),
              ...(llmError?.attemptCount === undefined ||
              !Number.isSafeInteger(llmError.attemptCount) ||
              llmError.attemptCount < 1
                ? {}
                : { attemptCount: llmError.attemptCount }),
              ...(llmError?.stage !== "provider-request"
                ? {}
                : readProviderFailure(llmError.providerFailure)),
            },
          },
        },
      );
      return resultFromWinner<TOutput>(winner, requested.informationId);
    } finally {
      controllers.delete(controller);
      if (controllers.size === 0)
        this.#inflight.delete(requested.informationId);
    }
    const winner = await this.#core.commitTerminal(
      terminalGroup,
      requested.informationId,
      modelTaskCompletedInformationKind,
      {
        ...this.terminalInput(requested),
        payload: completed,
      },
    );
    return resultFromWinner<TOutput>(winner, requested.informationId);
  }

  async cancel(
    request: ModelTaskCancellation,
  ): Promise<ModelTaskResult<unknown>> {
    try {
      if (typeof request.reason !== "string" || !request.reason.trim())
        throw new Error("Invalid cancellation");
      const atom = await this.#core.get(request.requestedInformationId);
      if (atom?.kind !== modelTaskRequestedInformationKind.kind)
        throw new Error("Invalid requested information");
      const requested = {
        ...atom,
        payload: modelTaskRequestedInformationKind.payloadSchema.parse(
          atom.payload,
        ),
      } as Requested;
      const winner = await this.#core.commitTerminal(
        terminalGroup,
        requested.informationId,
        modelTaskCancelledInformationKind,
        {
          ...this.terminalInput(requested),
          payload: {
            ...persistedMetadata(requested),
            durationMs: Math.max(
              0,
              this.#now().getTime() - Date.parse(requested.occurredAt),
            ),
            reason: "Explicit cancellation requested" as const,
          },
        },
      );
      if (winner.kind === modelTaskCancelledInformationKind.kind) {
        for (const controller of this.#inflight.get(requested.informationId) ??
          [])
          controller.abort();
      }
      return resultFromWinner(winner, requested.informationId);
    } catch {
      throw new Error("Model task cancellation could not be committed");
    }
  }

  private terminalInput(requested: Requested) {
    return {
      occurredAt: this.#now().toISOString(),
      source: "runtime:model-task",
      references: [
        { relation: "core:caused-by", informationId: requested.informationId },
        { relation: "core:status-of", informationId: requested.informationId },
        {
          relation: "core:context",
          informationId: requested.payload.contextInformationId,
        },
      ],
    };
  }
  private async readTerminal(informationId: string) {
    return (
      await this.#core.query({ informationId, relation: "core:status-of" })
    ).find(
      (a) =>
        a.kind === modelTaskCompletedInformationKind.kind ||
        a.kind === modelTaskFailedInformationKind.kind ||
        a.kind === modelTaskCancelledInformationKind.kind,
    );
  }
  private async readRequested(
    sourceInformationId: string,
    key: string,
  ): Promise<Requested | undefined> {
    const candidates = await this.#core.query({
      informationId: sourceInformationId,
      relation: "core:caused-by",
    });
    for (const atom of candidates) {
      if (atom.kind !== modelTaskRequestedInformationKind.kind) continue;
      const payload = modelTaskRequestedInformationKind.payloadSchema.parse(
        atom.payload,
      );
      if (modelTaskFingerprint(payload) === key)
        return {
          ...atom,
          kind: modelTaskRequestedInformationKind.kind,
          payload,
        };
    }
    return undefined;
  }
}

function readFailureMetrics(
  error: KaguyaLlmError | undefined,
  fallbackDurationMs: number,
): { durationMs: number; usage?: Record<string, number> } {
  const candidate = {
    durationMs: error?.durationMs ?? fallbackDurationMs,
    ...(error?.usage === undefined ? {} : { usage: error.usage }),
  };
  const validNumbers = z
    .object({
      durationMs: z.number().nonnegative(),
      usage: z.record(z.string(), z.number().nonnegative()).optional(),
    })
    .strict()
    .safeParse(candidate);
  if (
    !validNumbers.success ||
    !informationPayloadSchema.safeParse(validNumbers.data).success
  )
    return { durationMs: fallbackDurationMs };
  return {
    durationMs: validNumbers.data.durationMs,
    ...(validNumbers.data.usage === undefined
      ? {}
      : { usage: validNumbers.data.usage }),
  };
}

function readProviderFailure(value: unknown): {
  providerFailure?: z.infer<typeof modelTaskProviderFailureSchema>;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {};
  const input = value as Record<string, unknown>;
  const reason = modelTaskProviderReasonSchema.safeParse(input.reason);
  if (!reason.success) return {};
  const statusCode = modelTaskProviderStatusCodeSchema.safeParse(
    input.statusCode,
  );
  const code = modelTaskProviderCodeSchema.safeParse(input.code);
  const type = modelTaskProviderTypeSchema.safeParse(input.type);
  const candidate = {
    reason: reason.data,
    ...(statusCode.success && statusCode.data !== undefined
      ? { statusCode: statusCode.data }
      : {}),
    ...(code.success && code.data !== undefined ? { code: code.data } : {}),
    ...(type.success && type.data !== undefined ? { type: type.data } : {}),
  };
  const valid = modelTaskProviderFailureSchema.safeParse(candidate);
  if (!valid.success || !informationPayloadSchema.safeParse(candidate).success)
    return {};
  return { providerFailure: valid.data };
}

function persistedMetadata(requested: Requested) {
  const {
    prompt: _prompt,
    messages: _messages,
    mediaInputByteLength: _mediaBytes,
    inputBlocked: _blocked,
    ...metadata
  } = modelTaskRequestedInformationKind.payloadSchema.parse(requested.payload);
  return modelTaskMetadataSchema.parse(metadata);
}
async function resultFromWinner<T = unknown>(
  atom: DeepReadonly<InformationAtom>,
  requestedInformationId: string,
): Promise<ModelTaskResult<T>> {
  const identity = {
    requestedInformationId,
    terminalInformationId: atom.informationId,
  };
  if (atom.kind === modelTaskCompletedInformationKind.kind) {
    const { output, native, generationKind, toolCalls } =
      modelTaskCompletedInformationKind.payloadSchema.parse(atom.payload);
    if (generationKind === "tool-calls") {
      if (!native) throw new Error("Missing native tool response");
      return { ...identity, status: "tool-calls", native, calls: toolCalls };
    }
    return {
      ...identity,
      status: "completed",
      output: output as T,
      ...(native ? { native } : {}),
    };
  }
  if (atom.kind === modelTaskFailedInformationKind.kind)
    return {
      ...identity,
      status: "failed",
      error: modelTaskFailedInformationKind.payloadSchema.parse(atom.payload)
        .error,
    };
  if (atom.kind === modelTaskCancelledInformationKind.kind)
    return {
      ...identity,
      status: "cancelled",
      reason: modelTaskCancelledInformationKind.payloadSchema.parse(
        atom.payload,
      ).reason,
    };
  throw new Error("Invalid Model Task terminal");
}
function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
export function modelTaskFingerprint(
  metadata: Pick<
    z.infer<typeof modelTaskMetadataSchema>,
    | "taskId"
    | "outputMode"
    | "sourceInformationId"
    | "promptKind"
    | "promptTemplateId"
    | "promptTemplateDigest"
    | "promptDigest"
    | "provenance"
    | "selectionPolicy"
  > & {
    messagesDigest?: string | null;
    tools?: readonly NativeToolDeclaration[];
    nativeStep?: unknown;
    contextTrimming?: unknown;
  },
): string {
  return digest(
    canonical({
      taskId: metadata.taskId,
      outputMode: metadata.outputMode,
      sourceInformationId: metadata.sourceInformationId,
      promptKind: metadata.promptKind,
      promptTemplateId: metadata.promptTemplateId,
      promptTemplateDigest: metadata.promptTemplateDigest,
      promptDigest: metadata.promptDigest,
      provenance: metadata.provenance,
      selectionPolicy: metadata.selectionPolicy,
      ...(metadata.tools ? { tools: metadata.tools } : {}),
      ...(metadata.nativeStep ? { nativeStep: metadata.nativeStep } : {}),
      ...(metadata.contextTrimming
        ? { contextTrimming: metadata.contextTrimming }
        : {}),
      ...(metadata.messagesDigest
        ? { messagesDigest: metadata.messagesDigest }
        : {}),
    }),
  );
}
function canonical(value: unknown): string {
  const json = jsonValueSchema.parse(value);
  const sort = (v: JsonValue): JsonValue =>
    Array.isArray(v)
      ? v.map(sort)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((key) => [key, sort(v[key]!)]),
          )
        : v;
  return JSON.stringify(sort(json));
}
