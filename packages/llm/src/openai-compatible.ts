const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 500;

export interface OpenAiCompatibleRequest {
  apiKey: string;
  baseUrl?: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxRetries?: number;
  retryDelayMs?: number;
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
  sleep?: (milliseconds: number) => Promise<void>;
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
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(options: OpenAiCompatibleServiceOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#logger = options.logger ?? silentLogger;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  async call(
    request: OpenAiCompatibleRequest,
  ): Promise<OpenAiCompatibleResult> {
    const configuration = normalizeRequest(request);
    const startedAt = this.#now();
    let lastError: OpenAiCompatibleError | undefined;

    for (let attempt = 1; attempt <= configuration.maxRetries + 1; attempt++) {
      this.#logger.info({
        event: "llm.call.started",
        model: configuration.model,
        endpoint: configuration.logEndpoint,
        attempt,
      });

      try {
        const response = await this.#request(configuration, request.signal);
        const parsed = await parseResponse(response, attempt);
        const result: OpenAiCompatibleResult = {
          content: parsed.content,
          model: parsed.model ?? configuration.model,
          attempts: attempt,
          durationMs: Math.max(0, this.#now() - startedAt),
          ...(parsed.requestId === undefined
            ? {}
            : { requestId: parsed.requestId }),
          ...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
        };

        this.#logger.info({
          event: "llm.call.succeeded",
          model: configuration.model,
          endpoint: configuration.logEndpoint,
          attempt,
          durationMs: result.durationMs,
          ...(result.usage === undefined ? {} : { usage: result.usage }),
        });
        return result;
      } catch (error) {
        const normalized = normalizeCallError(error, attempt, request.signal);
        lastError = normalized;
        this.#logger.error({
          event: "llm.call.failed",
          model: configuration.model,
          endpoint: configuration.logEndpoint,
          attempt,
          durationMs: Math.max(0, this.#now() - startedAt),
          errorKind: normalized.kind,
          errorMessage: normalized.message,
          ...(normalized.status === undefined
            ? {}
            : { status: normalized.status }),
        });

        if (
          normalized.kind !== "retryable" ||
          attempt > configuration.maxRetries
        ) {
          throw normalized;
        }

        await this.#sleep(
          retryDelay(configuration.retryDelayMs, attempt, normalized.cause),
        );
      }
    }

    throw (
      lastError ??
      new OpenAiCompatibleError("Language model generation failed", {
        kind: "non-retryable",
        attempts: 0,
      })
    );
  }

  async #request(
    configuration: NormalizedRequest,
    callerSignal: AbortSignal | undefined,
  ): Promise<Response> {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    if (callerSignal?.aborted === true) {
      abortFromCaller();
    }
    const timeout = setTimeout(
      () => controller.abort(),
      configuration.timeoutMs,
    );

    try {
      return await this.#fetch(configuration.endpoint, {
        method: "POST",
        headers: configuration.headers,
        body: JSON.stringify({
          model: configuration.model,
          messages: [
            { role: "system", content: configuration.systemPrompt },
            { role: "user", content: configuration.userPrompt },
          ],
          temperature: configuration.temperature,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

interface NormalizedRequest {
  endpoint: string;
  logEndpoint: string;
  headers: Record<string, string>;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxRetries: number;
  retryDelayMs: number;
  timeoutMs: number;
}

function normalizeRequest(request: OpenAiCompatibleRequest): NormalizedRequest {
  const apiKey = requireText(request.apiKey, "apiKey");
  const model = requireText(request.model, "model");
  const systemPrompt = requireText(request.systemPrompt, "systemPrompt");
  const userPrompt = requireText(request.userPrompt, "userPrompt");
  const endpoint = resolveEndpoint(request.baseUrl);
  const temperature = request.temperature ?? 0;
  const maxRetries = integerInRange(
    request.maxRetries ?? DEFAULT_MAX_RETRIES,
    "maxRetries",
    0,
    10,
  );
  const retryDelayMs = integerInRange(
    request.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    "retryDelayMs",
    0,
    60_000,
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

  const apiKeyHeader = request.apiKeyHeader?.trim() || "Authorization";
  const authentication =
    apiKeyHeader.toLowerCase() === "authorization"
      ? `Bearer ${apiKey}`
      : apiKey;

  return {
    endpoint,
    logEndpoint: redactEndpoint(endpoint),
    model,
    systemPrompt,
    userPrompt,
    temperature,
    maxRetries,
    retryDelayMs,
    timeoutMs,
    headers: {
      ...request.additionalHeaders,
      "content-type": "application/json",
      [apiKeyHeader]: authentication,
    },
  };
}

function resolveEndpoint(baseUrl: string | undefined): string {
  let url: URL;
  try {
    url = new URL(baseUrl?.trim() || DEFAULT_BASE_URL);
  } catch (error) {
    throw configurationError("baseUrl must be a valid URL", error);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw configurationError("baseUrl must use http or https");
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname.endsWith("/chat/completions")) {
    url.pathname = `${pathname}/chat/completions`;
  }
  return url.toString();
}

function redactEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function parseResponse(
  response: Response,
  attempt: number,
): Promise<{
  content: string;
  model?: string;
  requestId?: string;
  usage?: OpenAiCompatibleUsage;
}> {
  const body = await readJson(response, attempt);

  if (!response.ok) {
    const message =
      providerErrorMessage(body) ?? `LLM API returned ${response.status}`;
    const cause = { response, body };
    throw new OpenAiCompatibleError(message, {
      kind: isRetryableStatus(response.status) ? "retryable" : "non-retryable",
      attempts: attempt,
      status: response.status,
      cause,
    });
  }

  const content = responseContent(body);
  if (content === undefined || content.trim().length === 0) {
    throw new OpenAiCompatibleError("LLM API returned empty content", {
      kind: "non-retryable",
      attempts: attempt,
      status: response.status,
      cause: body,
    });
  }

  const model = isRecord(body) ? textProperty(body, "model") : undefined;
  const requestId = response.headers.get("x-request-id") ?? undefined;
  const usage = responseUsage(body);
  return {
    content,
    ...(model === undefined ? {} : { model }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(usage === undefined ? {} : { usage }),
  };
}

async function readJson(response: Response, attempt: number): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new OpenAiCompatibleError("LLM API returned invalid JSON", {
      kind: response.ok ? "non-retryable" : "retryable",
      attempts: attempt,
      status: response.status,
      cause: error,
    });
  }
}

function responseContent(body: unknown): string | undefined {
  if (!isRecord(body) || !Array.isArray(body.choices)) {
    return undefined;
  }
  const choice = body.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    return undefined;
  }
  return textProperty(choice.message, "content");
}

function responseUsage(body: unknown): OpenAiCompatibleUsage | undefined {
  if (!isRecord(body) || !isRecord(body.usage)) {
    return undefined;
  }
  const promptTokens = numberProperty(body.usage, "prompt_tokens");
  const completionTokens = numberProperty(body.usage, "completion_tokens");
  const totalTokens = numberProperty(body.usage, "total_tokens");
  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }
  return {
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    totalTokens: totalTokens ?? (promptTokens ?? 0) + (completionTokens ?? 0),
  };
}

function providerErrorMessage(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  if (isRecord(body.error)) {
    return textProperty(body.error, "message");
  }
  return textProperty(body, "message");
}

function normalizeCallError(
  error: unknown,
  attempt: number,
  callerSignal: AbortSignal | undefined,
): OpenAiCompatibleError {
  if (error instanceof OpenAiCompatibleError) {
    return error;
  }
  if (callerSignal?.aborted === true) {
    return new OpenAiCompatibleError("LLM call cancelled", {
      kind: "cancelled",
      attempts: attempt,
      cause: error,
    });
  }
  return new OpenAiCompatibleError(errorMessage(error), {
    kind: "retryable",
    attempts: attempt,
    cause: error,
  });
}

function retryDelay(
  baseDelayMs: number,
  attempt: number,
  cause: unknown,
): number {
  const retryAfterMs = retryAfter(cause);
  return retryAfterMs ?? baseDelayMs * 2 ** (attempt - 1);
}

function retryAfter(cause: unknown): number | undefined {
  if (!isRecord(cause) || !(cause.response instanceof Response)) {
    return undefined;
  }
  const value = cause.response.headers.get("retry-after");
  if (value === null) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
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

function textProperty(value: Record<string, unknown>, key: string) {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function numberProperty(value: Record<string, unknown>, key: string) {
  return typeof value[key] === "number" && Number.isFinite(value[key])
    ? value[key]
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "Language model request failed";
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
