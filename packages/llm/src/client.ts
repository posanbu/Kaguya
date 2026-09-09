/**
 * 功能概述：提供无持久化副作用的结构化 LLM 调用边界，只负责模型解析、调用、输出校验、
 * usage 规范化、耗时计算和 provider 错误分类。
 * 主要职责：`KaguyaLlmClient.generate` 按显式 outputMode 选择纯文本或结构化输出，
 * 接收调用方提供的泛型 outputSchema 并返回
 * `KaguyaLlmGeneration<T>`；`KaguyaLlmError` 把取消、可重试和不可重试失败统一成稳定分类。
 * 代码库关系：Runtime 的 `LlmLifecycleClient` 在此边界外注册 requested/completed/failed 原子；
 * provider 组合层可注入单一 model 或按请求解析 model，本文件不依赖数据库或 trace repository。
 * 输入输出与副作用：输入包含 modelId、已编译 prompt、outputSchema 和可选 AbortSignal；调用
 * AI SDK 后返回 JSON-compatible output、可选数字 usage 与非负 durationMs。失败仅暴露分类信息。
 */
import type { CompiledPrompt, LlmErrorKind } from "@kaguya/schema";
import {
  APICallError,
  generateText,
  JSONParseError,
  NoObjectGeneratedError,
  Output,
  type FlexibleSchema,
  type LanguageModel,
  type LanguageModelUsage,
  RetryError,
} from "ai";

export interface KaguyaLlmRequest<TOutput = unknown> {
  readonly modelId: string;
  readonly prompt: CompiledPrompt;
  readonly outputMode: "text" | "object";
  readonly outputSchema: FlexibleSchema<TOutput>;
  readonly signal?: AbortSignal;
}

export interface KaguyaLlmGeneration<T> {
  readonly output: T;
  readonly usage?: Record<string, number>;
  readonly durationMs: number;
}

export type KaguyaLlmErrorKind = LlmErrorKind;
export type KaguyaLlmFailureStage =
  "provider-request" | "structured-output-parse";

export class KaguyaLlmError extends Error {
  readonly kind: KaguyaLlmErrorKind;
  readonly stage: KaguyaLlmFailureStage;
  readonly #cause: unknown;

  constructor(
    message: string,
    options: {
      kind: KaguyaLlmErrorKind;
      stage: KaguyaLlmFailureStage;
      cause: unknown;
    },
  ) {
    super(message);
    this.name = "KaguyaLlmError";
    this.kind = options.kind;
    this.stage = options.stage;
    this.#cause = options.cause;
  }
}

export type KaguyaLlmModelResolver = (
  request: KaguyaLlmRequest<unknown>,
) => LanguageModel;

export type KaguyaLlmClientOptions = {
  readonly now?: () => Date;
} & (
  | {
      readonly model: LanguageModel;
      readonly resolveModel?: never;
    }
  | {
      readonly model?: never;
      readonly resolveModel: KaguyaLlmModelResolver;
    }
);

export class KaguyaLlmClient {
  readonly #resolveModel: KaguyaLlmModelResolver;
  readonly #now: () => Date;

  constructor(options: KaguyaLlmClientOptions) {
    this.#resolveModel =
      options.resolveModel ?? (() => options.model as LanguageModel);
    this.#now = options.now ?? (() => new Date());
  }

  async generate<TOutput>(
    request: KaguyaLlmRequest<TOutput>,
  ): Promise<KaguyaLlmGeneration<TOutput>> {
    const startedAt = this.#now();
    try {
      const common = {
        model: this.#resolveModel(request),
        prompt: request.prompt.text,
        ...(request.signal === undefined
          ? {}
          : { abortSignal: request.signal }),
        maxRetries: 0,
      } as const;
      const result =
        request.outputMode === "text"
          ? await generateText({ ...common, output: Output.text() })
          : await generateText({
              ...common,
              output: Output.object({ schema: request.outputSchema }),
            });
      const completedAt = this.#now();
      const usage = normalizeUsage(result.usage);
      return {
        output: (request.outputMode === "text"
          ? (result.output as string).trim()
          : result.output) as TOutput,
        ...(usage === undefined ? {} : { usage }),
        durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      };
    } catch (error) {
      throw normalizeError(error);
    }
  }
}

function normalizeUsage(
  usage: LanguageModelUsage,
): Record<string, number> | undefined {
  const normalized = Object.fromEntries(
    Object.entries({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
    }).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    ),
  );
  return Object.keys(normalized).length === 0 ? undefined : normalized;
}

function normalizeError(error: unknown): KaguyaLlmError {
  if (error instanceof KaguyaLlmError) return error;

  if (NoObjectGeneratedError.isInstance(error)) {
    const message = JSONParseError.isInstance(error.cause)
      ? "Invalid JSON response for structured output"
      : "Invalid response structure for structured output";
    return new KaguyaLlmError(message, {
      kind: "non-retryable",
      stage: "structured-output-parse",
      cause: error,
    });
  }

  const kind: KaguyaLlmErrorKind = isAbortError(error)
    ? "cancelled"
    : isRetryableError(error)
      ? "retryable"
      : "non-retryable";
  return new KaguyaLlmError(controlledErrorMessage(kind), {
    kind,
    stage: "provider-request",
    cause: error,
  });
}

function isAbortError(error: unknown): boolean {
  if (RetryError.isInstance(error)) {
    return error.reason === "abort" || isAbortError(error.lastError);
  }
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

function isRetryableError(error: unknown): boolean {
  if (RetryError.isInstance(error)) return isRetryableError(error.lastError);
  if (APICallError.isInstance(error)) return error.isRetryable;
  return (
    typeof error === "object" &&
    error !== null &&
    "isRetryable" in error &&
    error.isRetryable === true
  );
}

function controlledErrorMessage(kind: KaguyaLlmErrorKind): string {
  switch (kind) {
    case "cancelled":
      return "Language model generation cancelled";
    case "retryable":
      return "Language model request failed and may be retried";
    case "non-retryable":
      return "Language model generation failed";
  }
}
