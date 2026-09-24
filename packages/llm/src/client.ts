/**
 * 功能概述：提供无持久化副作用的结构化 LLM 调用边界，只负责模型解析、调用、输出校验、
 * usage 累加、耗时计算和 provider 错误分类。JSON mode 最多两次，Schema mode 单次。
 * 主要职责：`KaguyaLlmClient.generate` 按显式 outputMode 选择纯文本或结构化输出，
 * 接收调用方提供的泛型 outputSchema 并返回
 * `KaguyaLlmGeneration<T>`；`KaguyaLlmError` 把取消、可重试和不可重试失败统一成稳定分类。
 * 代码库关系：Runtime 的 `ModelTaskClient` 在此边界外注册唯一 requested/completed/failed 原子；
 * provider 组合层可注入单一 model 或按请求解析 model，本文件不依赖数据库或 trace repository。
 * 输入输出与副作用：输入包含 modelId、已编译 prompt、outputSchema 和可选 AbortSignal；调用
 * generationOptions.timeoutMs（默认 300 秒）由共享取消信号覆盖全部尝试；外部 abort 优先。
 * JSON mode 给冻结 Prompt 附加固定 Schema 提示，使用 Output.json 请求并在本地严格校验；
 * schema mode 仅供已声明服务端 Schema 能力的模型使用。重试不附加模型原文、不重新选择模型。
 * PROVIDER_ERROR_CODES/TYPES 与 ProviderFailureReason 限定可流出边界的词表；
 * normalizeError 还从直接或包装的 APICallError 提取有界状态与固定词表诊断；原始错误、
 * 响应正文和请求数据仍只留在私有字段，供 Runtime 写入的字段不包含上游自由文本。
 */
import type { CompiledPrompt, LlmErrorKind } from "@kaguya/schema";
import {
  APICallError,
  asSchema,
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

/** Generation controls supplied by the selected Profile tier and Provider. */
export interface KaguyaLlmGenerationOptions {
  readonly structuredOutputMode?: "json" | "schema";
  readonly timeoutMs?: number;
  readonly reasoning?:
    | "provider-default"
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh";
  /** Soft latency target for scheduling and observability; never aborts a call. */
  readonly recommendedDurationMs?: number;
}

export interface KaguyaLlmGeneration<T> {
  readonly output: T;
  readonly usage?: Record<string, number>;
  readonly durationMs: number;
  readonly recommendedDurationMs?: number;
  readonly exceededRecommendedDuration?: boolean;
}

export type KaguyaLlmErrorKind = LlmErrorKind;
export type KaguyaLlmFailureStage =
  "provider-request" | "structured-output-parse";
export type KaguyaStructuredOutputFailure =
  "empty" | "invalid-json" | "schema-mismatch" | "truncated";
export const PROVIDER_ERROR_CODES = [
  "auth_error",
  "authentication_error",
  "invalid_api_key",
  "permission_denied",
  "insufficient_quota",
  "rate_limit_exceeded",
  "model_not_found",
  "invalid_request_error",
  "server_error",
] as const;
export const PROVIDER_ERROR_TYPES = [
  "auth_error",
  "authentication_error",
  "invalid_request_error",
  "permission_error",
  "rate_limit_error",
  "server_error",
] as const;
export type ProviderFailureReason =
  | "authentication-failed"
  | "credential-blocked"
  | "model-access-denied"
  | "rate-limited"
  | "invalid-request"
  | "model-not-found"
  | "provider-unavailable"
  | "unknown";
export interface ProviderFailure {
  readonly statusCode?: number;
  readonly code?: (typeof PROVIDER_ERROR_CODES)[number];
  readonly type?: (typeof PROVIDER_ERROR_TYPES)[number];
  readonly reason: ProviderFailureReason;
}

interface LlmFailureMetrics {
  readonly attemptCount?: number;
  readonly durationMs?: number;
  readonly usage?: Record<string, number>;
}

export class KaguyaLlmError extends Error {
  readonly kind: KaguyaLlmErrorKind;
  readonly stage: KaguyaLlmFailureStage;
  readonly structuredOutputFailure?: KaguyaStructuredOutputFailure;
  readonly providerFailure?: ProviderFailure;
  readonly attemptCount?: number;
  readonly durationMs?: number;
  readonly usage?: Record<string, number>;
  readonly #cause: unknown;

  constructor(
    message: string,
    options: {
      kind: KaguyaLlmErrorKind;
      stage: KaguyaLlmFailureStage;
      cause: unknown;
      structuredOutputFailure?: KaguyaStructuredOutputFailure;
      providerFailure?: ProviderFailure;
    } & LlmFailureMetrics,
  ) {
    super(message);
    this.name = "KaguyaLlmError";
    this.kind = options.kind;
    this.stage = options.stage;
    this.#cause = options.cause;
    if (options.structuredOutputFailure !== undefined)
      this.structuredOutputFailure = options.structuredOutputFailure;
    if (options.providerFailure !== undefined)
      this.providerFailure = options.providerFailure;
    if (options.attemptCount !== undefined)
      this.attemptCount = options.attemptCount;
    if (options.durationMs !== undefined) this.durationMs = options.durationMs;
    if (options.usage !== undefined) this.usage = options.usage;
  }
}

export type KaguyaLlmModelResolver = (
  request: KaguyaLlmRequest<unknown>,
) => LanguageModel;

export type KaguyaLlmClientOptions = {
  readonly now?: () => Date;
  readonly resolveGenerationOptions?: (
    request: KaguyaLlmRequest<unknown>,
  ) => KaguyaLlmGenerationOptions;
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
  readonly #resolveGenerationOptions: (
    request: KaguyaLlmRequest<unknown>,
  ) => KaguyaLlmGenerationOptions;

  constructor(options: KaguyaLlmClientOptions) {
    this.#resolveModel =
      options.resolveModel ?? (() => options.model as LanguageModel);
    this.#now = options.now ?? (() => new Date());
    this.#resolveGenerationOptions =
      options.resolveGenerationOptions ?? (() => ({}));
  }

  async generate<TOutput>(
    request: KaguyaLlmRequest<TOutput>,
  ): Promise<KaguyaLlmGeneration<TOutput>> {
    const startedAt = this.#now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let signal = request.signal;
    let attemptCount = 0;
    let usage: Record<string, number> | undefined;
    try {
      const generationOptions = this.#resolveGenerationOptions(request);
      const timeoutMs = generationOptions.timeoutMs ?? 300_000;
      if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 300_000
      ) {
        throw new Error("Invalid model timeout");
      }
      const mode = generationOptions.structuredOutputMode ?? "json";
      if (mode !== "json" && mode !== "schema")
        throw new Error("Invalid structured output mode");
      const deadline = new AbortController();
      timer = setTimeout(
        () => deadline.abort(new DOMException("Model timeout", "TimeoutError")),
        timeoutMs,
      );
      timer.unref();
      signal =
        request.signal === undefined
          ? deadline.signal
          : AbortSignal.any([request.signal, deadline.signal]);
      signal.throwIfAborted();
      const jsonMode = request.outputMode === "object" && mode === "json";
      const schema =
        request.outputMode === "object"
          ? asSchema(request.outputSchema)
          : undefined;
      if (jsonMode && schema?.validate === undefined)
        throw new Error("JSON output requires a local schema validator");
      const typedOutput =
        schema === undefined ? undefined : Output.object({ schema });
      const common = {
        timeout: timeoutMs,
        model: this.#resolveModel(request),
        prompt: request.prompt.text,
        abortSignal: signal,
        maxRetries: 0,
        ...(generationOptions.reasoning === undefined
          ? {}
          : { reasoning: generationOptions.reasoning }),
      } as const;
      // 所有尝试共享同一模型、Prompt 和 deadline；仅结构化生成失败允许一次恢复。
      let output: unknown;
      for (;;) {
        signal.throwIfAborted();
        attemptCount += 1;
        try {
          const result =
            request.outputMode === "text"
              ? await generateText({ ...common, output: Output.text() })
              : jsonMode
                ? await generateText({ ...common, output: Output.json() })
                : await generateText({
                    ...common,
                    output: typedOutput!,
                  });
          if (
            request.outputMode === "object" &&
            result.finishReason === "length"
          )
            throw new NoObjectGeneratedError({
              text: result.text,
              response: result.response,
              usage: result.usage,
              finishReason: result.finishReason,
            });
          // SDK 非 stop 结果没有可用 output；不将拒绝/工具调用等当成 JSON 重试。
          if (
            request.outputMode === "object" &&
            result.finishReason !== "stop"
          ) {
            usage = addUsage(usage, result.usage);
            throw new Error("Structured output did not complete");
          }
          output = jsonMode
            ? await typedOutput!.parseCompleteOutput(
                { text: result.text },
                result,
              )
            : request.outputMode === "text"
              ? (result.output as string).trim()
              : result.output;
          usage = addUsage(usage, result.usage);
          signal.throwIfAborted();
          break;
        } catch (error) {
          if (
            NoObjectGeneratedError.isInstance(error) &&
            error.usage !== undefined
          )
            usage = addUsage(usage, error.usage);
          signal.throwIfAborted();
          if (
            jsonMode &&
            attemptCount < 2 &&
            NoObjectGeneratedError.isInstance(error)
          )
            continue;
          throw error;
        }
      }
      const completedAt = this.#now();
      const durationMs = Math.max(
        0,
        completedAt.getTime() - startedAt.getTime(),
      );
      return {
        output: output as TOutput,
        ...(usage === undefined ? {} : { usage }),
        durationMs,
        ...(generationOptions.recommendedDurationMs === undefined
          ? {}
          : {
              recommendedDurationMs: generationOptions.recommendedDurationMs,
              exceededRecommendedDuration:
                durationMs > generationOptions.recommendedDurationMs,
            }),
      };
    } catch (error) {
      // 自定义 abort reason 也不能改变取消分类或暴露调用方内容。
      const failure = request.signal?.aborted
        ? new DOMException("Cancelled", "AbortError")
        : signal?.aborted
          ? signal.reason
          : error;
      throw normalizeError(failure, {
        attemptCount,
        durationMs: Math.max(0, this.#now().getTime() - startedAt.getTime()),
        ...(usage === undefined ? {} : { usage }),
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

function addUsage(
  previous: Record<string, number> | undefined,
  current: LanguageModelUsage,
): Record<string, number> | undefined {
  const next = normalizeUsage(current);
  if (next === undefined) return previous;
  const total = { ...previous };
  for (const [key, value] of Object.entries(next))
    total[key] = (total[key] ?? 0) + value;
  return total;
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

function normalizeError(
  error: unknown,
  metrics: LlmFailureMetrics,
): KaguyaLlmError {
  if (error instanceof KaguyaLlmError) return error;

  if (NoObjectGeneratedError.isInstance(error)) {
    const message = JSONParseError.isInstance(error.cause)
      ? "Invalid JSON response for structured output"
      : "Invalid response structure for structured output";
    return new KaguyaLlmError(message, {
      ...metrics,
      kind: "non-retryable",
      stage: "structured-output-parse",
      structuredOutputFailure:
        error.finishReason === "length"
          ? "truncated"
          : !error.text?.trim()
            ? "empty"
            : JSONParseError.isInstance(error.cause)
              ? "invalid-json"
              : "schema-mismatch",
      cause: error,
    });
  }

  const kind: KaguyaLlmErrorKind = isAbortError(error)
    ? "cancelled"
    : isRetryableError(error)
      ? "retryable"
      : "non-retryable";
  const diagnostic = kind === "cancelled" ? undefined : providerFailure(error);
  return new KaguyaLlmError(controlledErrorMessage(kind), {
    ...metrics,
    kind,
    stage: "provider-request",
    ...(diagnostic === undefined ? {} : { providerFailure: diagnostic }),
    cause: error,
  });
}

function providerFailure(error: unknown): ProviderFailure | undefined {
  const apiError = findApiCallError(error);
  if (apiError === undefined) return undefined;
  const statusCode =
    Number.isSafeInteger(apiError.statusCode) &&
    apiError.statusCode !== undefined &&
    apiError.statusCode >= 100 &&
    apiError.statusCode <= 599
      ? apiError.statusCode
      : undefined;
  // 仅从有限大小的 JSON 正文读取固定位置；匹配后立即丢弃自由文本。
  let body: Record<string, unknown> | undefined;
  if (
    apiError.responseBody !== undefined &&
    apiError.responseBody.length <= 16_384
  ) {
    try {
      const parsed: unknown = JSON.parse(apiError.responseBody);
      if (isRecord(parsed))
        body = isRecord(parsed.error) ? parsed.error : parsed;
    } catch {
      // 非 JSON/HTML 响应只允许 HTTP 状态参与诊断。
    }
  }
  const code = allowedIdentifier(body?.code, PROVIDER_ERROR_CODES);
  const type = allowedIdentifier(body?.type, PROVIDER_ERROR_TYPES);
  const message = typeof body?.message === "string" ? body.message : "";
  const blocked =
    /\b(?:api[ -]?key|key|credential|token)\s+(?:is\s+)?(?:blocked|disabled|revoked)\b/iu.test(
      message,
    );
  const reason = classifyProviderFailure(statusCode, code, type, blocked);
  return {
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(code === undefined ? {} : { code }),
    ...(type === undefined ? {} : { type }),
    reason,
  };
}

function classifyProviderFailure(
  statusCode: number | undefined,
  code: ProviderFailure["code"],
  type: ProviderFailure["type"],
  blocked: boolean,
): ProviderFailureReason {
  if (
    blocked &&
    (statusCode === 401 ||
      statusCode === 403 ||
      code === "auth_error" ||
      type === "auth_error")
  )
    return "credential-blocked";
  if (statusCode === 401) return "authentication-failed";
  if (statusCode === 403) return "model-access-denied";
  if (statusCode === 429) return "rate-limited";
  if (statusCode !== undefined && statusCode >= 500)
    return "provider-unavailable";
  if (code === "model_not_found") return "model-not-found";
  if (code === "server_error" || type === "server_error")
    return "provider-unavailable";
  if (
    code === "rate_limit_exceeded" ||
    code === "insufficient_quota" ||
    type === "rate_limit_error"
  )
    return "rate-limited";
  if (
    code === "invalid_api_key" ||
    code === "auth_error" ||
    code === "authentication_error" ||
    type === "auth_error" ||
    type === "authentication_error"
  )
    return "authentication-failed";
  if (code === "permission_denied" || type === "permission_error")
    return "model-access-denied";
  if (
    statusCode === 400 ||
    statusCode === 422 ||
    code === "invalid_request_error" ||
    type === "invalid_request_error"
  )
    return "invalid-request";
  return "unknown";
}

function findApiCallError(error: unknown): APICallError | undefined {
  let current = error;
  const seen = new Set<unknown>();
  for (
    let depth = 0;
    depth < 8 && current !== null && !seen.has(current);
    depth++
  ) {
    seen.add(current);
    if (APICallError.isInstance(current)) return current;
    if (RetryError.isInstance(current)) current = current.lastError;
    else if (isRecord(current)) current = current.cause;
    else return undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function allowedIdentifier<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === "string" &&
    value.length <= 64 &&
    /^[a-z][a-z0-9_]*$/u.test(value) &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
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
