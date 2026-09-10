/**
 * 功能概述：提供模块可声明的通用模型任务能力，任务 ID、版本及输出 schema 由调用方拥有。
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
 */
import { createHash } from "node:crypto";
import { InformationCore } from "@kaguya/engine";
import { KaguyaLlmError, type KaguyaLlmClient } from "@kaguya/llm/client";
import {
  type CompiledPrompt,
  type DeepReadonly,
  type InformationAtom,
  type JsonValue,
  jsonValueSchema,
  informationPayloadSchema,
  z,
} from "@kaguya/schema";
import {
  defineModuleCapability,
  type ModuleActivationProvenance,
} from "@kaguya/sdk";
import {
  informationCompiledPromptSchema,
  modelTaskMetadataSchema,
  modelTaskResolvedModelSchema,
  modelTaskSelectionPolicySchema,
  modelTaskRequestedInformationKind,
  modelTaskCompletedInformationKind,
  modelTaskFailedInformationKind,
  modelTaskCancelledInformationKind,
  modelTaskSafeErrorSchema,
} from "./information-kinds.js";

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
  readonly selectionPolicy: z.infer<typeof modelTaskSelectionPolicySchema>;
  readonly prompt: CompiledPrompt;
  readonly contextAtoms: readonly DeepReadonly<InformationAtom>[];
}
type ResultIdentity = {
  readonly requestedInformationId: string;
  readonly terminalInformationId: string;
};
export type ModelTaskResult<TOutput> = ResultIdentity &
  (
    | { readonly status: "completed"; readonly output: TOutput }
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
}
const terminalGroup = "kaguya.model.task.result.v1";
type Requested = DeepReadonly<
  InformationAtom<
    "core.model.task.requested",
    z.infer<typeof modelTaskRequestedInformationKind.payloadSchema>
  >
>;

export class ModelTaskClient implements ModelTaskCapability {
  readonly #core: InformationCore;
  readonly #client: Pick<KaguyaLlmClient, "generate">;
  readonly #resolveModel: ModelTaskClientOptions["resolveModel"];
  readonly #now: () => Date;
  constructor(options: ModelTaskClientOptions) {
    this.#core = options.core;
    this.#client = options.client;
    this.#resolveModel = options.resolveModel;
    this.#now = options.now ?? (() => new Date());
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
    const prompt = informationCompiledPromptSchema.parse(request.prompt);
    const metadata = modelTaskMetadataSchema
      .omit({ resolvedModel: true })
      .parse({
        taskId: task.taskId,
        version: task.version,
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
        provenance: prompt.provenance,
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
    const key = fingerprint(metadata);
    let requested = await this.readRequested(metadata.sourceInformationId, key);
    if (requested) {
      const terminal = await this.readTerminal(requested.informationId);
      if (terminal)
        return resultFromWinner<TOutput>(terminal, requested.informationId);
    }
    // 输入 JSON schema 不包含任务 transform；真实 client 在此边界只产生未转换输入。
    const providerSchema = z.fromJSONSchema(
      z.toJSONSchema(task.outputSchema, { io: "input" }),
    );
    const resolvedModel = requested
      ? undefined
      : modelTaskResolvedModelSchema.parse(this.#resolveModel(selectionPolicy));
    requested ??= await this.#core.registerOnce(
      "kaguya.model.task.requested.v1",
      key,
      modelTaskRequestedInformationKind,
      {
        occurredAt: this.#now().toISOString(),
        source: "runtime:model-task",
        payload: { ...metadata, prompt, resolvedModel: resolvedModel! },
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
    const persisted = persistedMetadata(requested);
    const startedAt = this.#now().getTime();
    let metrics:
      { durationMs: number; usage?: Record<string, number> } | undefined;
    let failureStage:
      | "provider-request"
      | "structured-output-parse"
      | "task-schema-validation" = "provider-request";
    let completed: z.infer<
      typeof modelTaskCompletedInformationKind.payloadSchema
    >;
    try {
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
      const signal = this.#core.executionSignal;
      const generation = await this.#client.generate({
        modelId: persisted.resolvedModel.modelId,
        prompt: informationCompiledPromptSchema.parse(requested.payload.prompt),
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
      const output = jsonValueSchema.parse(
        await task.outputSchema.parseAsync(generation.output),
      );
      completed = modelTaskCompletedInformationKind.payloadSchema.parse({
        ...persisted,
        output,
        ...metrics,
      });
      // 与 Core 的 atom payload 使用同一边界：账本受限标识字段属于输出失败。
      // 真正 commit 留在此 try 外，数据库故障、关闭及 claim fencing 不生成 failed。
      informationPayloadSchema.parse(completed);
    } catch (error) {
      if (this.#core.executionSignal?.aborted) {
        const winner = await this.readTerminal(requested.informationId);
        if (winner)
          return resultFromWinner<TOutput>(winner, requested.informationId);
        throw new Error("Model task execution interrupted");
      }
      const winner = await this.#core.commitTerminal(
        terminalGroup,
        requested.informationId,
        modelTaskFailedInformationKind,
        {
          ...this.terminalInput(requested),
          payload: {
            ...persisted,
            ...(metrics ?? {
              durationMs: Math.max(0, this.#now().getTime() - startedAt),
            }),
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
            },
          },
        },
      );
      return resultFromWinner<TOutput>(winner, requested.informationId);
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
      if (fingerprint(payload) === key)
        return {
          ...atom,
          kind: modelTaskRequestedInformationKind.kind,
          payload,
        };
    }
    return undefined;
  }
}

function persistedMetadata(requested: Requested) {
  const { prompt: _prompt, ...metadata } =
    modelTaskRequestedInformationKind.payloadSchema.parse(requested.payload);
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
    const { output } = modelTaskCompletedInformationKind.payloadSchema.parse(
      atom.payload,
    );
    return {
      ...identity,
      status: "completed",
      output: output as T,
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
function fingerprint(
  metadata: Pick<
    z.infer<typeof modelTaskMetadataSchema>,
    | "taskId"
    | "version"
    | "outputMode"
    | "sourceInformationId"
    | "promptKind"
    | "promptTemplateId"
    | "promptTemplateDigest"
    | "promptDigest"
    | "provenance"
    | "selectionPolicy"
  >,
): string {
  return digest(
    canonical({
      taskId: metadata.taskId,
      version: metadata.version,
      outputMode: metadata.outputMode,
      sourceInformationId: metadata.sourceInformationId,
      promptKind: metadata.promptKind,
      promptTemplateId: metadata.promptTemplateId,
      promptTemplateDigest: metadata.promptTemplateDigest,
      promptDigest: metadata.promptDigest,
      provenance: metadata.provenance,
      selectionPolicy: metadata.selectionPolicy,
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
