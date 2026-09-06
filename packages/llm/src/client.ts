/**
 * 功能概述：提供无持久化副作用的结构化 LLM 调用边界，只负责模型解析、调用、输出校验、
 * usage 规范化、耗时计算和 provider 错误分类。
 * 主要职责：`KaguyaLlmClient.generate` 返回 `KaguyaLlmGeneration<T>`；`KaguyaLlmError`
 * 把取消、可重试和不可重试失败统一成稳定分类；schema 选择 helper 为四类 prompt 校验输出。
 * 代码库关系：Runtime 的 `LlmLifecycleClient` 在此边界外注册 requested/completed/failed 原子；
 * provider 组合层可注入单一 model 或按请求解析 model，本文件不依赖数据库或 trace repository。
 * 输入输出与副作用：输入包含 kind、modelId 和已编译 prompt；调用 AI SDK 后返回 JSON-compatible
 * output、可选数字 usage 与非负 durationMs。失败保留 cause 供调用栈处理，但不会自行记录日志。
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

import {
  type KaguyaLlmOutputByKind,
  memoryOutputSchema,
  replyOutputSchema,
  routeOutputSchema,
  stateOutputSchema,
} from "./schemas.js";

export interface KaguyaLlmRequest {
  readonly kind: keyof KaguyaLlmOutputByKind;
  readonly modelId: string;
  readonly prompt: CompiledPrompt;
}

export interface KaguyaLlmGeneration<T> {
  readonly output: T;
  readonly usage?: Record<string, number>;
  readonly durationMs: number;
}

export type KaguyaLlmErrorKind = LlmErrorKind;

export class KaguyaLlmError extends Error {
  readonly kind: KaguyaLlmErrorKind;
  override readonly cause: unknown;

  constructor(
    message: string,
    options: { kind: KaguyaLlmErrorKind; cause: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "KaguyaLlmError";
    this.kind = options.kind;
    this.cause = options.cause;
  }
}

export type KaguyaLlmModelResolver = (
  request: KaguyaLlmRequest,
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

  async generate<K extends KaguyaLlmRequest["kind"]>(
    request: KaguyaLlmRequest & { readonly kind: K },
  ): Promise<KaguyaLlmGeneration<KaguyaLlmOutputByKind[K]>> {
    const startedAt = this.#now();
    try {
      const result = await generateText({
        model: this.#resolveModel(request),
        prompt: request.prompt.text,
        output: Output.object({
          schema: outputSchemaFor(request.kind),
          name: `${request.kind}Output`,
        }),
      });
      const completedAt = this.#now();
      const usage = normalizeUsage(result.usage);
      return {
        output: result.output,
        ...(usage === undefined ? {} : { usage }),
        durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      };
    } catch (error) {
      throw normalizeError(error);
    }
  }
}

const outputSchemas = {
  route: routeOutputSchema,
  reply: replyOutputSchema,
  state: stateOutputSchema,
  memory: memoryOutputSchema,
} as const;

function outputSchemaFor<K extends keyof KaguyaLlmOutputByKind>(
  kind: K,
): FlexibleSchema<KaguyaLlmOutputByKind[K]> {
  return outputSchemas[kind] as FlexibleSchema<KaguyaLlmOutputByKind[K]>;
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
      cause: error,
    });
  }

  const kind: KaguyaLlmErrorKind = isAbortError(error)
    ? "cancelled"
    : isRetryableError(error)
      ? "retryable"
      : "non-retryable";
  return new KaguyaLlmError(errorMessage(error), { kind, cause: error });
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

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return "Language model generation failed";
}
