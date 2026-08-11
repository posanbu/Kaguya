import type { CompiledPrompt, LlmErrorKind, LlmTrace } from "@kaguya/schema";
import {
  APICallError,
  generateText,
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
  kind: keyof KaguyaLlmOutputByKind;
  modelId: string;
  prompt: CompiledPrompt;
  traceId: string;
  workflowId: string;
  nodeId: string;
}

export interface KaguyaLlmGenerateRequest extends KaguyaLlmRequest {
  traceRecordId: string;
}

export interface LlmTraceWriter {
  write(trace: LlmTrace): Promise<void>;
}

export type KaguyaLlmErrorKind = LlmErrorKind;

export class KaguyaLlmError extends Error {
  readonly kind: KaguyaLlmErrorKind;
  override readonly cause: unknown;
  traceWriteError?: Error;

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

export class TracePersistenceError extends Error {
  override readonly cause: Error;

  constructor(cause: Error) {
    super("Failed to persist LLM trace", { cause });
    this.name = "TracePersistenceError";
    this.cause = cause;
  }
}

interface KaguyaLlmClientBaseOptions {
  traceWriter: LlmTraceWriter;
  now: () => Date;
}

export type KaguyaLlmModelResolver = (
  request: KaguyaLlmRequest,
) => LanguageModel;

export type KaguyaLlmClientOptions = KaguyaLlmClientBaseOptions &
  (
    | {
        model: LanguageModel;
        resolveModel?: never;
      }
    | {
        model?: never;
        resolveModel: KaguyaLlmModelResolver;
      }
  );

/**
 * The workflow-facing LLM boundary. Provider SDKs create a Vercel AI SDK
 * LanguageModel; this client owns generation, output validation, and tracing.
 */
export class KaguyaLlmClient {
  readonly #resolveModel: (request: KaguyaLlmRequest) => LanguageModel;
  readonly #traceWriter: LlmTraceWriter;
  readonly #now: () => Date;

  constructor(options: KaguyaLlmClientOptions) {
    this.#resolveModel =
      options.resolveModel ?? (() => options.model as LanguageModel);
    this.#traceWriter = options.traceWriter;
    this.#now = options.now;
  }

  async generate<K extends KaguyaLlmRequest["kind"]>(
    request: KaguyaLlmGenerateRequest & { kind: K },
  ): Promise<KaguyaLlmOutputByKind[K]> {
    const id = request.traceRecordId;
    const startedAt = this.#now();
    let response: KaguyaLlmOutputByKind[K] | undefined;
    let usage: Record<string, unknown> | undefined;
    let failure: KaguyaLlmError | undefined;

    try {
      const result = await generateText({
        model: this.#resolveModel(request),
        prompt: request.prompt.text,
      });

      usage = normalizeUsage(result.usage);
      response = parseOutput(request.kind, result.text);
    } catch (error) {
      failure = normalizeError(error);
    } finally {
      const completedAt = this.#now();
      const baseTrace = {
        id,
        traceId: request.traceId,
        workflowId: request.workflowId,
        nodeId: request.nodeId,
        kind: request.kind,
        modelId: request.modelId,
        prompt: request.prompt,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
        ...(usage === undefined ? {} : { usage }),
      };

      const trace: LlmTrace =
        failure === undefined
          ? {
              ...baseTrace,
              status: "completed",
              response,
            }
          : {
              ...baseTrace,
              status: "failed",
              error: {
                name: failure.name,
                message: failure.message,
                kind: failure.kind,
              },
            };

      try {
        await this.#traceWriter.write(trace);
      } catch (error) {
        const traceWriteError = normalizeTraceWriteError(error);
        if (failure === undefined) {
          throw new TracePersistenceError(traceWriteError);
        }
        failure.traceWriteError = traceWriteError;
      }
    }

    if (failure !== undefined) {
      throw failure;
    }

    return response as KaguyaLlmOutputByKind[K];
  }
}

function parseOutput<K extends keyof KaguyaLlmOutputByKind>(
  kind: K,
  text: string,
): KaguyaLlmOutputByKind[K] {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new KaguyaLlmError(`Invalid JSON response for ${kind}`, {
      kind: "non-retryable",
      cause: error,
    });
  }

  try {
    switch (kind) {
      case "route":
        return routeOutputSchema.parse(value) as KaguyaLlmOutputByKind[K];
      case "reply":
        return replyOutputSchema.parse(value) as KaguyaLlmOutputByKind[K];
      case "state":
        return stateOutputSchema.parse(value) as KaguyaLlmOutputByKind[K];
      case "memory":
        return memoryOutputSchema.parse(value) as KaguyaLlmOutputByKind[K];
    }
  } catch (error) {
    throw new KaguyaLlmError(`Invalid response structure for ${kind}`, {
      kind: "non-retryable",
      cause: error,
    });
  }
}

function normalizeUsage(
  usage: LanguageModelUsage,
): Record<string, unknown> | undefined {
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
  if (error instanceof KaguyaLlmError) {
    return error;
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
  if (RetryError.isInstance(error)) {
    return isRetryableError(error.lastError);
  }

  if (APICallError.isInstance(error)) {
    return error.isRetryable;
  }

  return (
    typeof error === "object" &&
    error !== null &&
    "isRetryable" in error &&
    error.isRetryable === true
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.length > 0) {
    return error;
  }

  return "Language model generation failed";
}

function normalizeTraceWriteError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(errorMessage(error), { cause: error });
}
