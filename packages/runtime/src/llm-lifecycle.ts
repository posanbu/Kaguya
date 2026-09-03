/**
 * 功能概述：把一次 reply LLM 调用表达为 PostgreSQL 信息账本中的 requested 与单一终态原子。
 * 主要职责：`LlmLifecycleClient.generate` 在 provider 调用前注册 requested，成功后注册包含
 * output/usage/duration 的 completed，失败后注册脱敏 failed 并重新抛出分类后的 `KaguyaLlmError`。
 * 代码库关系：依赖底层无持久化 `KaguyaLlmClient` 和 Runtime 自有 lifecycle definitions；
 * `runtime.ts` 将本类适配为 `createLlmInformationReplyModule` 所需的 executor。
 * 输入输出与副作用：输入 context 与 reply atom 必须属于同一 context；所有生命周期 atom 使用
 * `runtime:llm` source，终态的 caused-by/status-of 都直接指向 requested，且继承唯一 context。
 */
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
  llmCompletedInformationKind,
  llmFailedInformationKind,
  llmRequestedInformationKind,
  type LlmCompletedInformationPayload,
} from "./information-kinds.js";

export interface LlmLifecycleRequest {
  readonly kind: "reply";
  readonly modelId: string;
  readonly workflowId: string;
  readonly nodeId: string;
  readonly prompt: CompiledPrompt;
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
    } as const;
    const requested = await this.#core.register(llmRequestedInformationKind, {
      occurredAt: this.#now().toISOString(),
      source: "runtime:llm",
      payload: { ...metadata, prompt: request.prompt as never },
      references: [
        {
          relation: "core:caused-by",
          informationId: causedByAtom.informationId,
        },
        {
          relation: "core:context",
          informationId: contextAtom.informationId,
        },
      ],
    });

    let generation;
    try {
      generation = await this.#client.generate({
        kind: request.kind,
        modelId: request.modelId,
        prompt: request.prompt,
      });
    } catch (error) {
      const classified = classifyLlmError(error);
      await this.#core.register(llmFailedInformationKind, {
        occurredAt: this.#now().toISOString(),
        source: "runtime:llm",
        payload: {
          ...metadata,
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
      });
      throw classified;
    }

    return this.#core.register(llmCompletedInformationKind, {
      occurredAt: this.#now().toISOString(),
      source: "runtime:llm",
      payload: {
        ...metadata,
        output: generation.output,
        reply: request.reply,
        ...(generation.usage === undefined ? {} : { usage: generation.usage }),
        durationMs: generation.durationMs,
      },
      references: terminalReferences(
        requested.informationId,
        contextAtom.informationId,
      ),
    });
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
