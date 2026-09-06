/**
 * 功能概述：把 reply LLM 调用表达为可重放 requested 与跨 kind 唯一终态。
 * 主要职责：generate 校验 Prompt provenance 和共享 context，以 operationKey 注册 requested，
 * 优先复用已有终态，再调用底层 client；成功/失败竞争同一 terminal slot 并返回实际赢家。
 * 代码库关系：apps composition root 将本类绑定为模块声明的 executor；Core 隐式传播 claim fencing，
 * KaguyaLlmClient 接收执行 AbortSignal，终态 definitions 由 information-kinds 提供。
 * 输入输出与副作用：可能调用外部模型并持久化生命周期；请求/终态分别使用稳定业务键和 requested ID，
 * 不依赖实例身份去重；外部成功后、提交前崩溃仍可能重调模型，错误正文仅保留安全分类。
 */
import { defineInformationSelector } from "@kaguya/sdk";
import { InformationCore } from "@kaguya/engine";
import {
  KaguyaLlmClient,
  KaguyaLlmError,
  type KaguyaLlmErrorKind,
} from "@kaguya/llm/client";
import type { ReplyRequestedInformationPayload } from "@kaguya/modules";
import type {
  CompiledPrompt,
  DeepReadonly,
  InformationAtom,
} from "@kaguya/schema";

import {
  informationCompiledPromptSchema,
  llmCompletedInformationKind,
  llmFailedInformationKind,
  llmRequestedInformationKind,
  type LlmCompletedInformationPayload,
} from "./information-kinds.js";

export interface LlmLifecycleRequest {
  readonly operationKey: string;
  readonly kind: "reply";
  readonly modelId: string;
  readonly workflowId: string;
  readonly nodeId: string;
  readonly originatingModuleInstanceId: string;
  readonly prompt: CompiledPrompt;
  readonly contextAtoms: readonly DeepReadonly<InformationAtom>[];
  readonly reply: ReplyRequestedInformationPayload;
}

export interface LlmLifecycleClientOptions {
  readonly core: InformationCore;
  readonly client: KaguyaLlmClient;
  readonly now?: () => Date;
}

export class LlmLifecycleClient {
  readonly #core: InformationCore;
  readonly #client: KaguyaLlmClient;
  readonly #now: () => Date;

  constructor(options: LlmLifecycleClientOptions) {
    this.#core = options.core;
    this.#client = options.client;
    this.#now = options.now ?? (() => new Date());
  }

  async generate(
    request: LlmLifecycleRequest,
    contextAtom: DeepReadonly<InformationAtom<"core.runtime.context">>,
    causedByAtom: DeepReadonly<
      InformationAtom<"core.reply.requested", ReplyRequestedInformationPayload>
    >,
  ): Promise<
    DeepReadonly<
      InformationAtom<"core.llm.completed", LlmCompletedInformationPayload>
    >
  > {
    assertSharedContext(contextAtom, causedByAtom);
    const metadata = {
      kind: request.kind,
      modelId: request.modelId,
      workflowId: request.workflowId,
      nodeId: request.nodeId,
      originatingModuleInstanceId: request.originatingModuleInstanceId,
    } as const;
    const prompt = informationCompiledPromptSchema.parse(request.prompt);
    assertPromptContext(prompt, request.contextAtoms, causedByAtom);
    const requested = await this.#core.registerOnce(
      "kaguya.llm.requested.v1",
      request.operationKey,
      llmRequestedInformationKind,
      {
        occurredAt: this.#now().toISOString(),
        source: "runtime:llm",
        payload: { ...metadata, prompt },
        references: [
          {
            relation: "core:caused-by",
            informationId: causedByAtom.informationId,
          },
          {
            relation: "core:context",
            informationId: contextAtom.informationId,
          },
          ...request.contextAtoms.map(({ informationId }) => ({
            relation: "core:uses-context" as const,
            informationId,
          })),
        ],
      },
    );

    const existing = await this.#core.select(
      llmTerminalSelector,
      requested.informationId,
    );
    if (existing[0]) return requireCompleted(existing[0]);

    const persistedMetadata = {
      kind: requested.payload.kind,
      modelId: requested.payload.modelId,
      workflowId: requested.payload.workflowId,
      nodeId: requested.payload.nodeId,
      originatingModuleInstanceId:
        requested.payload.originatingModuleInstanceId,
    };
    let generation;
    try {
      if (request.modelId !== requested.payload.modelId) {
        throw new KaguyaLlmError(
          "The recorded model is unavailable in the current configuration",
          { kind: "non-retryable", cause: undefined },
        );
      }
      const persistedKind = requested.payload.kind;
      if (persistedKind !== "reply")
        throw new Error("Recorded request is not a reply task");
      generation = await this.#client.generate({
        ...(this.#core.executionSignal
          ? { signal: this.#core.executionSignal }
          : {}),
        kind: persistedKind,
        modelId: requested.payload.modelId,
        prompt: informationCompiledPromptSchema.parse(requested.payload.prompt),
      });
    } catch (error) {
      const classified = classifyLlmError(error);
      const winner = await this.#core.commitTerminal(
        "kaguya.llm.result.v1",
        requested.informationId,
        llmFailedInformationKind,
        {
          occurredAt: this.#now().toISOString(),
          source: "runtime:llm",
          payload: {
            ...persistedMetadata,
            error: {
              name: classified.name,
              kind: classified.kind,
              message: safeFailureMessage(classified.kind),
            },
          },
          references: terminalReferences(
            requested.informationId,
            contextAtom.informationId,
          ),
        },
      );
      if (winner.kind === llmCompletedInformationKind.kind)
        return requireCompleted(winner);
      throw classified;
    }

    const winner = await this.#core.commitTerminal(
      "kaguya.llm.result.v1",
      requested.informationId,
      llmCompletedInformationKind,
      {
        occurredAt: this.#now().toISOString(),
        source: "runtime:llm",
        payload: {
          ...persistedMetadata,
          output: generation.output,
          reply: request.reply,
          ...(generation.usage === undefined
            ? {}
            : { usage: generation.usage }),
          durationMs: generation.durationMs,
        },
        references: terminalReferences(
          requested.informationId,
          contextAtom.informationId,
        ),
      },
    );
    return requireCompleted(winner);
  }
}

const llmTerminalSelector = defineInformationSelector({
  selectorId: "runtime.llm.terminal",
  select: async ({ sourceAtom, ledger }) =>
    (
      await ledger.related({
        from: [sourceAtom.informationId],
        relation: "core:status-of",
        direction: "incoming",
        limit: 2,
      })
    )
      .filter(
        (atom) =>
          atom.kind === llmCompletedInformationKind.kind ||
          atom.kind === llmFailedInformationKind.kind,
      )
      .map((atom) => atom.informationId),
});
function requireCompleted(
  atom: DeepReadonly<InformationAtom>,
): DeepReadonly<
  InformationAtom<"core.llm.completed", LlmCompletedInformationPayload>
> {
  if (atom.kind === llmCompletedInformationKind.kind)
    return atom as DeepReadonly<
      InformationAtom<"core.llm.completed", LlmCompletedInformationPayload>
    >;
  throw new KaguyaLlmError("Language model generation previously failed", {
    kind: "non-retryable",
    cause: undefined,
  });
}

function assertPromptContext(
  prompt: CompiledPrompt,
  contextAtoms: readonly DeepReadonly<InformationAtom>[],
  causedByAtom: DeepReadonly<InformationAtom>,
): void {
  const selectedIds = contextAtoms.map(({ informationId }) => informationId);
  const provenanceIds = prompt.provenance.flatMap(({ informationId }) =>
    informationId === undefined ? [] : [informationId],
  );
  if (
    selectedIds.length !== provenanceIds.length ||
    selectedIds.some(
      (informationId, index) => informationId !== provenanceIds[index],
    )
  ) {
    throw new Error("Prompt provenance must match selected information order");
  }
  if (!selectedIds.includes(causedByAtom.informationId)) {
    throw new Error("Selected information must include the reply source");
  }
}

function terminalReferences(
  requestedInformationId: string,
  contextInformationId: string,
) {
  return [
    {
      relation: "core:caused-by",
      informationId: requestedInformationId,
    },
    {
      relation: "core:status-of",
      informationId: requestedInformationId,
    },
    {
      relation: "core:context",
      informationId: contextInformationId,
    },
  ];
}

function assertSharedContext(
  contextAtom: DeepReadonly<InformationAtom<"core.runtime.context">>,
  causedByAtom: DeepReadonly<InformationAtom>,
): void {
  const contexts = causedByAtom.references.filter(
    ({ relation }) => relation === "core:context",
  );
  if (
    contexts.length !== 1 ||
    contexts[0]?.informationId !== contextAtom.informationId
  ) {
    throw new Error("LLM source atom must belong to the supplied context");
  }
}

function classifyLlmError(error: unknown): KaguyaLlmError {
  if (error instanceof KaguyaLlmError) return error;
  return new KaguyaLlmError("Language model generation failed", {
    kind: "non-retryable",
    cause: error,
  });
}

function safeFailureMessage(kind: KaguyaLlmErrorKind): string {
  return kind === "cancelled"
    ? "Language model generation was cancelled"
    : "Language model generation failed";
}
