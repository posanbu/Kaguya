import {
  createOpenAICompatible,
  type OpenAICompatibleProviderSettings,
} from "@ai-sdk/openai-compatible";
import { APICallError, RetryError, generateText } from "ai";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;

export interface OpenAiCompatibleRequest {
  apiKey: string;
  baseUrl?: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxRetries?: number;
  timeoutMs?: number;
  apiKeyHeader?: string;
  additionalHeaders?: Record<string, string>;
  signal?: AbortSignal;
}

export interface OpenAiCompatibleUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface OpenAiCompatibleResult {
  content: string;
  model: string;
  requestId?: string;
  usage?: OpenAiCompatibleUsage;
  attempts: number;
  durationMs: number;
}

export type OpenAiCompatibleErrorKind =
  "cancelled" | "configuration" | "non-retryable" | "retryable";

export class OpenAiCompatibleError extends Error {
  readonly kind: OpenAiCompatibleErrorKind;
  readonly status?: number;
  readonly attempts: number;
  override readonly cause: unknown;

  constructor(
    message: string,
    options: {
      kind: OpenAiCompatibleErrorKind;
      attempts: number;
      cause?: unknown;
      status?: number;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "OpenAiCompatibleError";
    this.kind = options.kind;
    this.attempts = options.attempts;
    this.cause = options.cause;
    if (options.status !== undefined) {
      this.status = options.status;
    }
  }
}

export interface OpenAiCompatibleLogEvent {
  event: "llm.call.failed" | "llm.call.started" | "llm.call.succeeded";
  model: string;
  endpoint: string;
  attempt: number;
  durationMs?: number;
  status?: number;
  usage?: OpenAiCompatibleUsage;
  errorKind?: OpenAiCompatibleErrorKind;
  errorMessage?: string;
}

export interface OpenAiCompatibleLogger {
  info(event: OpenAiCompatibleLogEvent): void;
  error(event: OpenAiCompatibleLogEvent): void;
}

export interface OpenAiCompatibleServiceOptions {
  fetch?: typeof fetch;
  logger?: OpenAiCompatibleLogger;
  now?: () => number;
}

const silentLogger: OpenAiCompatibleLogger = {
  info() {},
  error() {},
};

export function createConsoleLlmLogger(): OpenAiCompatibleLogger {
  return {
    info(event) {
      console.info(JSON.stringify(event));
    },
    error(event) {
      console.error(JSON.stringify(event));
    },
  };
}

export class OpenAiCompatibleLlmService {
  readonly #fetch: typeof fetch;
  readonly #logger: OpenAiCompatibleLogger;
  readonly #now: () => number;

  constructor(options: OpenAiCompatibleServiceOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#logger = options.logger ?? silentLogger;
    this.#now = options.now ?? Date.now;
  }

  async call(
    request: OpenAiCompatibleRequest,
  ): Promise<OpenAiCompatibleResult> {
    const configuration = normalizeRequest(request);
    const startedAt = this.#now();
    let attempts = 0;

    const trackedFetch: typeof fetch = async (input, init) => {
      attempts += 1;
      this.#logger.info({
        event: "llm.call.started",
        model: configuration.model,
        endpoint: configuration.logEndpoint,
        attempt: attempts,
      });
      return this.#fetch(appendRawQuery(input, configuration.rawQuery), {
        ...init,
        redirect: "error",
      });
    };

    try {
      const providerOptions: OpenAICompatibleProviderSettings = {
        name: "kaguya-openai-compatible",
        baseURL: configuration.baseUrl,
        headers: configuration.headers,
        fetch: trackedFetch,
        ...(configuration.providerApiKey === undefined
          ? {}
          : { apiKey: configuration.providerApiKey }),
      };
      const provider = createOpenAICompatible(providerOptions);
      const generated = await generateText({
        model: provider.chatModel(configuration.model),
        system: configuration.systemPrompt,
        prompt: configuration.userPrompt,
        temperature: configuration.temperature,
        maxRetries: configuration.maxRetries,
        timeout: configuration.timeoutMs,
        ...(request.signal === undefined
          ? {}
          : { abortSignal: request.signal }),
      });

      if (generated.text.trim().length === 0) {
        throw new OpenAiCompatibleError("LLM API returned empty content", {
          kind: "non-retryable",
          attempts: Math.max(1, attempts),
        });
      }

      const usage = normalizeUsage(generated.usage);
      const requestId = headerValue(generated.response.headers, "x-request-id");
      const result: OpenAiCompatibleResult = {
        content: generated.text,
        model: generated.response.modelId || configuration.model,
        attempts: Math.max(1, attempts),
        durationMs: Math.max(0, this.#now() - startedAt),
        ...(requestId === undefined ? {} : { requestId }),
        ...(usage === undefined ? {} : { usage }),
      };

      this.#logger.info({
        event: "llm.call.succeeded",
        model: configuration.model,
        endpoint: configuration.logEndpoint,
        attempt: result.attempts,
        durationMs: result.durationMs,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      });
      return result;
    } catch (error) {
      const normalized = normalizeSdkError(error, attempts, request.signal);
      this.#logger.error({
        event: "llm.call.failed",
        model: configuration.model,
        endpoint: configuration.logEndpoint,
        attempt: normalized.attempts,
        durationMs: Math.max(0, this.#now() - startedAt),
        errorKind: normalized.kind,
        ...(normalized.status === undefined
          ? {}
          : { status: normalized.status }),
      });
      throw normalized;
    }
  }
}

interface NormalizedRequest {
  baseUrl: string;
  logEndpoint: string;
  rawQuery?: string;
  providerApiKey?: string;
  headers: Record<string, string>;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxRetries: number;
  timeoutMs: number;
}

function normalizeRequest(request: OpenAiCompatibleRequest): NormalizedRequest {
  const apiKey = requireText(request.apiKey, "apiKey");
  const model = requireText(request.model, "model");
  const systemPrompt = requireText(request.systemPrompt, "systemPrompt");
  const userPrompt = requireText(request.userPrompt, "userPrompt");
  const endpoint = resolveProviderEndpoint(request.baseUrl);
  const temperature = request.temperature ?? 0;
  const maxRetries = integerInRange(
    request.maxRetries ?? DEFAULT_MAX_RETRIES,
    "maxRetries",
    0,
    10,
  );
  const timeoutMs = integerInRange(
    request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "timeoutMs",
    1,
    300_000,
  );

  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw configurationError("temperature must be between 0 and 2");
  }
  if (hasHeaderControlCharacters(apiKey)) {
    throw configurationError("apiKey contains invalid header characters");
  }

  const apiKeyHeader = request.apiKeyHeader?.trim() || "Authorization";
  if (!isHeaderName(apiKeyHeader)) {
    throw configurationError("apiKeyHeader must be a valid HTTP header name");
  }
  if (apiKeyHeader.toLowerCase() === "content-type") {
    throw configurationError("apiKeyHeader cannot be content-type");
  }
  const authentication = authenticationOptions(
    apiKey,
    apiKeyHeader,
    request.additionalHeaders,
  );

  return {
    baseUrl: endpoint.baseUrl,
    logEndpoint: endpoint.logEndpoint,
    ...(endpoint.rawQuery === undefined ? {} : { rawQuery: endpoint.rawQuery }),
    model,
    systemPrompt,
    userPrompt,
    temperature,
    maxRetries,
    timeoutMs,
    ...(authentication.providerApiKey === undefined
      ? {}
      : { providerApiKey: authentication.providerApiKey }),
    headers: authentication.headers,
  };
}

function resolveProviderEndpoint(baseUrl: string | undefined): {
  baseUrl: string;
  logEndpoint: string;
  rawQuery?: string;
} {
  let url: URL;
  try {
    url = new URL(baseUrl?.trim() || DEFAULT_BASE_URL);
  } catch (error) {
    throw configurationError("baseUrl must be a valid URL", error);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw configurationError("baseUrl must use http or https");
  }
  if (url.username || url.password) {
    throw configurationError("baseUrl cannot contain embedded credentials");
  }

  const rawQuery = url.search;
  url.search = "";
  url.hash = "";
  let pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/chat/completions")) {
    pathname = pathname.slice(0, -"/chat/completions".length);
  }
  url.pathname = pathname || "/";

  const base = url.toString().replace(/\/$/u, "");
  return {
    baseUrl: base,
    logEndpoint: `${base}/chat/completions`,
    ...(rawQuery.length === 0 ? {} : { rawQuery }),
  };
}

function appendRawQuery(
  input: RequestInfo | URL,
  rawQuery: string | undefined,
): RequestInfo | URL {
  if (rawQuery === undefined) {
    return input;
  }

  const append = (value: string) => {
    const fragmentIndex = value.indexOf("#");
    const endpoint =
      fragmentIndex === -1 ? value : value.slice(0, fragmentIndex);
    const fragment = fragmentIndex === -1 ? "" : value.slice(fragmentIndex);
    const separator = endpoint.includes("?")
      ? endpoint.endsWith("?") || endpoint.endsWith("&")
        ? ""
        : "&"
      : "?";
    return `${endpoint}${separator}${rawQuery.slice(1)}${fragment}`;
  };

  if (typeof input === "string") {
    return append(input);
  }
  if (input instanceof URL) {
    return append(input.toString());
  }
  return new Request(append(input.url), input);
}

function authenticationOptions(
  apiKey: string,
  apiKeyHeader: string,
  additionalHeaders: Record<string, string> | undefined,
): { providerApiKey?: string; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(additionalHeaders ?? {})) {
    if (!isHeaderName(name) || hasHeaderControlCharacters(value)) {
      throw configurationError("additionalHeaders contains an invalid header");
    }
    const normalizedName = name.toLowerCase();
    if (normalizedName === "content-type") {
      throw configurationError(
        "additionalHeaders cannot override the content-type header",
      );
    }
    if (normalizedName !== apiKeyHeader.toLowerCase()) {
      headers[name] = value;
    }
  }
  if (apiKeyHeader.toLowerCase() === "authorization") {
    return { providerApiKey: apiKey, headers };
  }
  headers[apiKeyHeader] = apiKey;
  return { headers };
}

function normalizeUsage(usage: {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
}): OpenAiCompatibleUsage | undefined {
  if (
    usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    usage.totalTokens === undefined
  ) {
    return undefined;
  }
  const promptTokens = usage.inputTokens ?? 0;
  const completionTokens = usage.outputTokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.totalTokens ?? promptTokens + completionTokens,
  };
}

function normalizeSdkError(
  error: unknown,
  fetchAttempts: number,
  callerSignal: AbortSignal | undefined,
): OpenAiCompatibleError {
  if (error instanceof OpenAiCompatibleError) {
    return error;
  }

  const retryError = RetryError.isInstance(error) ? error : undefined;
  const underlying = retryError?.lastError ?? error;
  const apiError = findApiCallError(underlying);
  const attempts = Math.max(1, fetchAttempts, retryError?.errors.length ?? 0);

  if (
    callerSignal?.aborted === true ||
    retryError?.reason === "abort" ||
    isAbortError(underlying)
  ) {
    return new OpenAiCompatibleError("LLM call cancelled", {
      kind: "cancelled",
      attempts,
      cause: error,
      ...(apiError?.statusCode === undefined
        ? {}
        : { status: apiError.statusCode }),
    });
  }

  const kind: OpenAiCompatibleErrorKind =
    apiError === undefined
      ? retryError?.reason === "maxRetriesExceeded"
        ? "retryable"
        : "non-retryable"
      : apiError.isRetryable
        ? "retryable"
        : "non-retryable";

  return new OpenAiCompatibleError(errorMessage(underlying), {
    kind,
    attempts,
    cause: error,
    ...(apiError?.statusCode === undefined
      ? {}
      : { status: apiError.statusCode }),
  });
}

function findApiCallError(error: unknown): APICallError | undefined {
  if (APICallError.isInstance(error)) {
    return error;
  }
  if (isRecord(error) && APICallError.isInstance(error.cause)) {
    return error.cause;
  }
  return undefined;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return true;
    }
    return error.cause === undefined ? false : isAbortError(error.cause);
  }
  return false;
}

function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  const match = Object.entries(headers ?? {}).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return match?.[1];
}

function requireText(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw configurationError(`${name} is required`);
  }
  return normalized;
}

function integerInRange(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw configurationError(
      `${name} must be between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function configurationError(message: string, cause?: unknown) {
  return new OpenAiCompatibleError(message, {
    kind: "configuration",
    attempts: 0,
    cause,
  });
}

function isHeaderName(value: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(value);
}

function hasHeaderControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "Language model request failed";
}
