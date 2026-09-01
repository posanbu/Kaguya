import { AsyncLocalStorage } from "node:async_hooks";

import pino, {
  type Bindings,
  type DestinationStream,
  type LevelWithSilent,
  type Logger,
  type LoggerOptions,
} from "pino";
import pinoPretty from "pino-pretty";

export {
  MAX_INFORMATION_CONTENT_CODE_POINTS,
  createInformationAtomLogSink,
  previewInformationContent,
  projectInformationAtomLog,
  type CreateInformationAtomLogSinkOptions,
  type InformationAtomLogEmergencyReporter,
  type InformationAtomLogError,
  type InformationAtomLogSink,
} from "./information.js";

const MAX_CONTEXT_VALUE_LENGTH = 512;
const MAX_NAMESPACE_LENGTH = 128;
const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const LOG_CONTEXT_KEYS = new Set<keyof LogContext>([
  "traceId",
  "eventId",
  "runId",
  "requestId",
  "workflowId",
  "nodeId",
]);
const LOG_LEVELS = new Set<LogLevel>([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent",
]);

export const DEFAULT_REDACT_PATHS = Object.freeze([
  "apiKey",
  "*.apiKey",
  "api_key",
  "*.api_key",
  "authorization",
  "*.authorization",
  "token",
  "*.token",
  "accessToken",
  "*.accessToken",
  "access_token",
  "*.access_token",
  "refreshToken",
  "*.refreshToken",
  "password",
  "*.password",
  "secret",
  "*.secret",
  "errorMessage",
  "*.errorMessage",
  "prompt",
  "*.prompt",
  "systemPrompt",
  "*.systemPrompt",
  "userPrompt",
  "*.userPrompt",
  "content",
  "*.content",
  "text",
  "*.text",
  "body",
  "*.body",
  "credentials",
  "*.credentials",
  "raw",
  "*.raw",
  "target",
  "*.target",
  "wsUrl",
  "*.wsUrl",
  "headers.authorization",
  "req.headers.authorization",
  "request.headers.authorization",
]);

export type KaguyaLogger = Logger;
export type LogLevel = LevelWithSilent;
export type LogFormat = "json" | "pretty";

export interface LogContext {
  readonly traceId?: string;
  readonly eventId?: string;
  readonly runId?: string;
  readonly requestId?: string;
  readonly workflowId?: string;
  readonly nodeId?: string;
}

export interface CreateLoggerOptions {
  readonly service: string;
  readonly module?: string;
  readonly level?: LogLevel;
  readonly namespaceLevels?: Readonly<Record<string, LogLevel>>;
  readonly async?: boolean;
  readonly format?: LogFormat;
  readonly destination?: string | number;
  readonly stream?: DestinationStream;
  readonly base?: Bindings;
  readonly redact?: readonly string[];
}

export interface SafeErrorLog {
  readonly type: string;
  readonly code?: string | number;
  readonly statusCode?: number;
  readonly retryable?: boolean;
  readonly errorKind?: SafeLlmErrorKind;
  readonly llmFailure?: SafeLlmFailure;
  readonly failureCount?: number;
}

type SafeLlmErrorKind =
  "retryable" | "non-retryable" | "cancelled" | "configuration";
type SafeLlmFailure =
  | "connection_failed"
  | "invalid_json_response"
  | "invalid_response_structure"
  | "provider_request_failed";

const SAFE_LLM_ERROR_KINDS = new Set<SafeLlmErrorKind>([
  "retryable",
  "non-retryable",
  "cancelled",
  "configuration",
]);

interface NamespaceLevelRule {
  readonly namespace: string;
  readonly level: LogLevel;
}

interface LoggerState {
  readonly namespaceLevels: readonly NamespaceLevelRule[];
  readonly stream: DestinationStream;
  readonly closeStream: boolean;
}

const contextStorage = new AsyncLocalStorage<Readonly<LogContext>>();
const loggerStates = new WeakMap<KaguyaLogger, LoggerState>();

export function createLogger(options: CreateLoggerOptions): KaguyaLogger {
  const service = validNamespace(options.service, "service");
  const module =
    options.module === undefined
      ? undefined
      : validNamespace(options.module, "module");
  const defaultLevel = validLevel(options.level ?? "info", "level");
  const namespaceLevels = normalizeNamespaceLevels(options.namespaceLevels);
  validateOutputOptions(options);

  const output = createOutput(options);
  const loggerOptions: LoggerOptions = {
    level:
      module === undefined
        ? defaultLevel
        : (namespaceLevel(namespaceLevels, module) ?? defaultLevel),
    base: {
      ...options.base,
      service,
      ...(module === undefined ? {} : { module }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    mixin() {
      return { ...getLogContext() };
    },
    mixinMergeStrategy(mergeObject, mixinObject) {
      return { ...mergeObject, ...mixinObject };
    },
    hooks: {
      logMethod(arguments_, method) {
        const first = arguments_[0];
        if (
          arguments_.length === 1 &&
          (first instanceof Error ||
            (isRecord(first) &&
              (first.err instanceof Error || first.error instanceof Error)))
        ) {
          const message =
            isRecord(first) &&
            typeof first.event === "string" &&
            first.event.length > 0
              ? first.event
              : "operation.failed";
          return method.apply(this, [
            first instanceof Error ? { err: first } : first,
            message,
          ]);
        }
        return method.apply(this, arguments_);
      },
    },
    redact: {
      paths: [...new Set([...DEFAULT_REDACT_PATHS, ...(options.redact ?? [])])],
      censor: "[REDACTED]",
    },
    serializers: {
      err: toSafeError,
      error: toSafeError,
      req: serializeRequest,
      res: serializeResponse,
    },
  };
  const logger = pino(loggerOptions, output.stream);
  loggerStates.set(logger, {
    namespaceLevels,
    stream: output.stream,
    closeStream: output.closeStream,
  });
  return logger;
}

export function createModuleLogger(
  parent: KaguyaLogger,
  namespace: string,
  bindings: Bindings = {},
): KaguyaLogger {
  const module = validNamespace(namespace, "namespace");
  const state = loggerStates.get(parent);
  const level =
    state === undefined
      ? undefined
      : namespaceLevel(state.namespaceLevels, module);
  const child = parent.child(
    { ...bindings, module },
    level === undefined ? undefined : { level },
  );
  if (state !== undefined) {
    loggerStates.set(child, { ...state, closeStream: false });
  }
  return child;
}

export function runWithLogContext<Result>(
  context: LogContext,
  callback: () => Result,
): Result {
  const parent = contextStorage.getStore();
  const merged = Object.freeze({
    ...parent,
    ...normalizeContext(context),
  });
  return contextStorage.run(merged, callback);
}

export function getLogContext(): Readonly<LogContext> | undefined {
  return contextStorage.getStore();
}

export function readLoggerOptions(
  service: string,
  environment: NodeJS.ProcessEnv = process.env,
): CreateLoggerOptions {
  const options: CreateLoggerOptions = {
    service: validNamespace(service, "service"),
    level: environmentLevel(environment.KAGUYA_LOG_LEVEL, "info"),
    namespaceLevels: parseNamespaceLevels(environment.KAGUYA_LOG_LEVELS),
    async: environmentBoolean(environment.KAGUYA_LOG_ASYNC, false),
    format: environmentLogFormat(
      environment.KAGUYA_LOG_FORMAT,
      environment.NODE_ENV === "development" ? "pretty" : "json",
    ),
    destination: environmentDestination(environment.KAGUYA_LOG_DESTINATION),
  };
  validateOutputOptions(options);
  return options;
}

export async function flushLogger(logger: KaguyaLogger): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    logger.flush((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

export async function closeLogger(logger: KaguyaLogger): Promise<void> {
  await flushLogger(logger);
  const state = loggerStates.get(logger);
  const stream = state?.stream;
  if (state?.closeStream !== true || !isClosableStream(stream)) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const complete = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    stream.once("error", fail);
    stream.once("close", complete);
    stream.once("finish", complete);
    stream.end();
  });
}

export function toSafeError(error: unknown): SafeErrorLog {
  if (!isRecord(error)) {
    return { type: "NonError" };
  }
  const type =
    typeof error.name === "string" && error.name.length > 0
      ? error.name
      : "Error";
  const code =
    typeof error.code === "string" || typeof error.code === "number"
      ? error.code
      : undefined;
  const statusCodeValue = error.statusCode ?? error.status;
  const statusCode =
    typeof statusCodeValue === "number" && Number.isFinite(statusCodeValue)
      ? statusCodeValue
      : undefined;
  const retryable =
    typeof error.retryable === "boolean"
      ? error.retryable
      : typeof error.isRetryable === "boolean"
        ? error.isRetryable
        : undefined;
  const aggregate = aggregateSummary(error);
  const errorKind = safeLlmErrorKind(type, error.kind) ?? aggregate?.errorKind;
  const llmFailure = classifyLlmFailure(type, error) ?? aggregate?.llmFailure;
  return {
    type,
    ...(code === undefined ? {} : { code }),
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(retryable === undefined ? {} : { retryable }),
    ...(errorKind === undefined ? {} : { errorKind }),
    ...(llmFailure === undefined ? {} : { llmFailure }),
    ...(aggregate === undefined
      ? {}
      : { failureCount: aggregate.failureCount }),
  };
}

function aggregateSummary(error: Record<string, unknown>):
  | {
      readonly errorKind?: SafeLlmErrorKind;
      readonly llmFailure?: SafeLlmFailure;
      readonly failureCount: number;
    }
  | undefined {
  if (!(error instanceof AggregateError)) {
    return undefined;
  }
  const leaves = aggregateLeaves(error);
  const errorKind = oneDistinct(leaves.map((leaf) => safeLeafErrorKind(leaf)));
  const llmFailure = oneDistinct(
    leaves.map((leaf) => {
      if (!isRecord(leaf)) return undefined;
      const leafType =
        typeof leaf.name === "string" && leaf.name.length > 0
          ? leaf.name
          : "Error";
      return classifyLlmFailure(leafType, leaf);
    }),
  );
  return {
    ...(errorKind === undefined ? {} : { errorKind }),
    ...(llmFailure === undefined ? {} : { llmFailure }),
    failureCount: leaves.length,
  };
}

function aggregateLeaves(error: AggregateError): unknown[] {
  return error.errors.flatMap((child) =>
    child instanceof AggregateError ? aggregateLeaves(child) : [child],
  );
}

function safeLeafErrorKind(error: unknown): SafeLlmErrorKind | undefined {
  if (!isRecord(error)) return undefined;
  const type =
    typeof error.name === "string" && error.name.length > 0
      ? error.name
      : "Error";
  const explicit = safeLlmErrorKind(type, error.kind);
  if (explicit !== undefined) return explicit;
  return type === "AbortError" ? "cancelled" : undefined;
}

function oneDistinct<Value>(
  values: readonly (Value | undefined)[],
): Value | undefined {
  const first = values[0];
  return first !== undefined && values.every((value) => value === first)
    ? first
    : undefined;
}

function safeLlmErrorKind(
  type: string,
  value: unknown,
): SafeLlmErrorKind | undefined {
  return type === "KaguyaLlmError" &&
    typeof value === "string" &&
    SAFE_LLM_ERROR_KINDS.has(value as SafeLlmErrorKind)
    ? (value as SafeLlmErrorKind)
    : undefined;
}

function classifyLlmFailure(
  type: string,
  error: Record<string, unknown>,
): SafeLlmFailure | undefined {
  if (type !== "KaguyaLlmError") {
    return undefined;
  }

  const message =
    typeof error.message === "string" ? error.message.toLowerCase() : "";
  if (message.includes("invalid json response")) {
    return "invalid_json_response";
  }
  if (message.includes("invalid response structure")) {
    return "invalid_response_structure";
  }
  if (isConnectionFailureMessage(message)) {
    return "connection_failed";
  }
  return "provider_request_failed";
}

function isConnectionFailureMessage(message: string): boolean {
  return [
    "cannot connect to api",
    "network socket disconnected",
    "fetch failed",
    "connection refused",
    "econnrefused",
    "econnreset",
    "enotfound",
    "etimedout",
    "tls connection",
  ].some((fragment) => message.includes(fragment));
}

function createOutput(options: CreateLoggerOptions): {
  stream: DestinationStream;
  closeStream: boolean;
} {
  if (options.format === "pretty") {
    const destination = options.destination ?? 1;
    return {
      stream: pinoPretty({
        destination,
        sync: true,
        colorize:
          destination === 1
            ? process.stdout.isTTY
            : destination === 2
              ? process.stderr.isTTY
              : false,
        translateTime: "SYS:standard",
        singleLine: true,
        messageFormat: "{module} {event} {msg}",
        ignore: "service,module,event,pid,hostname",
      }),
      closeStream: false,
    };
  }
  if (options.stream !== undefined) {
    return { stream: options.stream, closeStream: false };
  }
  const destination = options.destination ?? 1;
  if (options.async === true) {
    return {
      stream: pino.transport({
        target: "pino/file",
        options: {
          destination,
          ...(typeof destination === "string" ? { mkdir: true } : {}),
        },
      }),
      closeStream: true,
    };
  }
  return {
    stream: pino.destination({
      dest: destination,
      sync: true,
      ...(typeof destination === "string" ? { mkdir: true } : {}),
    }),
    closeStream: destination !== 1 && destination !== 2,
  };
}

function validateOutputOptions(options: CreateLoggerOptions): void {
  if (options.stream !== undefined && options.async === true) {
    throw new TypeError("stream and async logging cannot be enabled together");
  }
  if (options.stream !== undefined && options.destination !== undefined) {
    throw new TypeError("stream and destination cannot be configured together");
  }
  if (options.format !== "pretty") {
    return;
  }
  if (options.async === true) {
    throw new TypeError("pretty logging cannot be asynchronous");
  }
  if (options.stream !== undefined) {
    throw new TypeError("pretty logging only supports stdout or stderr");
  }
  const destination = options.destination ?? 1;
  if (destination !== 1 && destination !== 2) {
    throw new TypeError("pretty logging only supports stdout or stderr");
  }
}

function environmentLogFormat(
  value: string | undefined,
  fallback: LogFormat,
): LogFormat {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (normalized === "json" || normalized === "pretty") {
    return normalized;
  }
  throw new TypeError("KAGUYA_LOG_FORMAT must be json or pretty");
}

function normalizeContext(context: LogContext): LogContext {
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => {
      if (!LOG_CONTEXT_KEYS.has(key as keyof LogContext)) {
        throw new TypeError(`${key} is not a supported log context field`);
      }
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > MAX_CONTEXT_VALUE_LENGTH
      ) {
        throw new TypeError(
          `${key} must be a non-empty string no longer than ${MAX_CONTEXT_VALUE_LENGTH} characters`,
        );
      }
      return [key, value];
    }),
  );
}

function normalizeNamespaceLevels(
  values: Readonly<Record<string, LogLevel>> | undefined,
): readonly NamespaceLevelRule[] {
  return Object.entries(values ?? {})
    .map(([namespace, level]) => ({
      namespace: validNamespace(namespace, "namespace"),
      level: validLevel(level, `level for ${namespace}`),
    }))
    .sort((left, right) => right.namespace.length - left.namespace.length);
}

function parseNamespaceLevels(
  value: string | undefined,
): Readonly<Record<string, LogLevel>> {
  const result: Record<string, LogLevel> = {};
  for (const item of (value ?? "").split(",")) {
    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }
    const separator = trimmed.lastIndexOf("=");
    if (separator <= 0 || separator === trimmed.length - 1) {
      throw new TypeError("KAGUYA_LOG_LEVELS must use namespace=level entries");
    }
    const namespace = validNamespace(
      trimmed.slice(0, separator).trim(),
      "namespace",
    );
    result[namespace] = validLevel(
      trimmed.slice(separator + 1).trim(),
      `level for ${namespace}`,
    );
  }
  return result;
}

function namespaceLevel(
  rules: readonly NamespaceLevelRule[],
  namespace: string,
): LogLevel | undefined {
  return rules.find(
    (rule) =>
      namespace === rule.namespace ||
      namespace.startsWith(`${rule.namespace}:`),
  )?.level;
}

function environmentLevel(
  value: string | undefined,
  fallback: LogLevel,
): LogLevel {
  const trimmed = value?.trim();
  return trimmed ? validLevel(trimmed, "KAGUYA_LOG_LEVEL") : fallback;
}

function environmentBoolean(
  value: string | undefined,
  fallback: boolean,
): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  throw new TypeError("KAGUYA_LOG_ASYNC must be true, false, 1, or 0");
}

function environmentDestination(value: string | undefined): string | number {
  const destination = value?.trim();
  if (!destination || destination.toLowerCase() === "stdout") {
    return 1;
  }
  if (destination.toLowerCase() === "stderr") {
    return 2;
  }
  return destination;
}

function validLevel(value: string, label: string): LogLevel {
  if (!LOG_LEVELS.has(value as LogLevel)) {
    throw new TypeError(`${label} must be a valid Pino log level`);
  }
  return value as LogLevel;
}

function validNamespace(value: string, label: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_NAMESPACE_LENGTH ||
    !NAMESPACE_PATTERN.test(normalized)
  ) {
    throw new TypeError(`${label} must be a valid logging namespace`);
  }
  return normalized;
}

function serializeRequest(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  const raw = isRecord(value.raw) ? value.raw : value;
  const socket = isRecord(raw.socket) ? raw.socket : undefined;
  const method = stringValue(value.method) ?? stringValue(raw.method);
  const url = stringValue(value.url) ?? stringValue(raw.url);
  const requestId = scalarValue(value.id);
  const remoteAddress =
    stringValue(value.ip) ?? stringValue(socket?.remoteAddress);
  const remotePort = numberValue(socket?.remotePort);
  return {
    ...(requestId === undefined ? {} : { requestId }),
    ...(method === undefined ? {} : { method }),
    ...(url === undefined ? {} : { path: url.split(/[?#]/u, 1)[0] }),
    ...(remoteAddress === undefined ? {} : { remoteAddress }),
    ...(remotePort === undefined ? {} : { remotePort }),
  };
}

function serializeResponse(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  const raw = isRecord(value.raw) ? value.raw : value;
  const statusCode =
    numberValue(value.statusCode) ?? numberValue(raw.statusCode);
  return statusCode === undefined ? {} : { statusCode };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function scalarValue(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number"
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isClosableStream(
  value: DestinationStream | undefined,
): value is DestinationStream & {
  end(): void;
  once(event: "error", callback: (error: Error) => void): void;
  once(event: "close" | "finish", callback: () => void): void;
} {
  return (
    value !== undefined &&
    "end" in value &&
    typeof value.end === "function" &&
    "once" in value &&
    typeof value.once === "function"
  );
}
