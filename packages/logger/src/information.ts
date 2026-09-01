/**
 * 架构说明：本模块把信息原子投影成对外可见的日志行，负责正文预览、
 * 统一身份字段回填、投影结果校验与失败汇报，避免日志路径泄漏原始负载。
 * 代码库关系：`packages/logger/src/index.ts` 通过这里导出正文预览、
 * 投影与 sink 工厂；`InformationCore.subscribeAll()` 可以注册这里生成的 sink。
 */
import type { InformationAtom, JsonObject, JsonValue } from "@kaguya/schema";
import type {
  InformationKindDefinition,
  InformationLogLevel,
} from "@kaguya/sdk";
import type { Logger } from "pino";

export const MAX_INFORMATION_CONTENT_CODE_POINTS = 168;

export interface InformationAtomLogError {
  readonly informationId: string;
  readonly kind: string;
  readonly errorType: string;
}

export type InformationAtomLogEmergencyReporter = (
  error: InformationAtomLogError,
) => void | Promise<void>;

export type InformationAtomLogSink = (
  atom: InformationAtom,
) => Promise<void>;

export interface CreateInformationAtomLogSinkOptions {
  readonly logger: Logger;
  readonly definitions:
    | ReadonlyMap<string, InformationKindDefinition<string, any>>
    | readonly InformationKindDefinition<string, any>[];
  readonly emergencyReporter?: InformationAtomLogEmergencyReporter;
}

const PROJECTED_IDENTITY_KEYS = Object.freeze([
  "informationId",
  "kind",
  "occurredAt",
  "source",
] as const);

export function previewInformationContent(input: string): {
  readonly contentPreview: string;
  readonly contentLength: number;
  readonly contentTruncated: boolean;
} {
  const codePoints = Array.from(input);
  const contentLength = codePoints.length;
  const contentTruncated = contentLength > MAX_INFORMATION_CONTENT_CODE_POINTS;
  const visible = contentTruncated
    ? codePoints.slice(0, MAX_INFORMATION_CONTENT_CODE_POINTS)
    : codePoints;
  return {
    contentPreview: visible.map(escapePreviewCodePoint).join("") + (contentTruncated ? "…" : ""),
    contentLength,
    contentTruncated,
  };
}

export async function projectInformationAtomLog<P extends JsonObject>(
  logger: Logger,
  definition: InformationKindDefinition<string, P>,
  atom: InformationAtom<string, P>,
  emergencyReporter?: InformationAtomLogEmergencyReporter,
): Promise<void> {
  if (!definition.log.enabled) {
    return;
  }

  const projection = normalizeProjection(definition.log.project(atom));
  if (projection === undefined) {
    await reportProjectionError(emergencyReporter, {
      informationId: atom.informationId,
      kind: atom.kind,
      errorType: "invalid_projection_result",
    });
    return;
  }

  try {
    logger[definition.log.level]({
      ...projection,
      informationId: atom.informationId,
      kind: atom.kind,
      occurredAt: atom.occurredAt,
      source: atom.source,
    });
  } catch {
    await reportProjectionError(emergencyReporter, {
      informationId: atom.informationId,
      kind: atom.kind,
      errorType: "logger_write_failed",
    });
  }
}

export function createInformationAtomLogSink(
  options: CreateInformationAtomLogSinkOptions,
): InformationAtomLogSink {
  const definitions = normalizeDefinitions(options.definitions);
  return async (atom) => {
    const definition = definitions.get(atom.kind);
    if (definition === undefined) {
      await reportProjectionError(options.emergencyReporter, {
        informationId: atom.informationId,
        kind: atom.kind,
        errorType: "unknown_information_kind",
      });
      return;
    }

    await projectInformationAtomLog(
      options.logger,
      definition as InformationKindDefinition<string, JsonObject>,
      atom as InformationAtom<string, JsonObject>,
      options.emergencyReporter,
    );
  };
}

function normalizeDefinitions(
  definitions:
    | ReadonlyMap<string, InformationKindDefinition<string, any>>
    | readonly InformationKindDefinition<string, any>[],
): ReadonlyMap<string, InformationKindDefinition<string, any>> {
  const normalized = new Map<string, InformationKindDefinition<string, any>>();
  if (definitions instanceof Map) {
    for (const [kind, definition] of definitions.entries()) {
      normalized.set(kind, definition);
    }
    return normalized;
  }

  for (const definition of definitions as readonly InformationKindDefinition<
    string,
    any
  >[]) {
    normalized.set(definition.kind, definition);
  }
  return normalized;
}

function normalizeProjection(
  projection: unknown,
): JsonObject | undefined {
  if (!isPlainObject(projection)) {
    return undefined;
  }

  const cloned = cloneJsonObject(projection);
  if (cloned === undefined) {
    return undefined;
  }

  return cloned;
}

function cloneJsonObject(value: JsonObject): JsonObject | undefined {
  const clone: JsonObject = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      return undefined;
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      return undefined;
    }

    const clonedValue = cloneJsonValue(descriptor.value);
    if (clonedValue === undefined) {
      return undefined;
    }
    clone[key] = clonedValue;
  }
  return clone;
}

function cloneJsonValue(value: unknown): JsonValue | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (Array.isArray(value)) {
    const clone: JsonValue[] = [];
    for (const item of value) {
      const clonedItem = cloneJsonValue(item);
      if (clonedItem === undefined) {
        return undefined;
      }
      clone.push(clonedItem);
    }
    return clone;
  }

  if (!isPlainObject(value)) {
    return undefined;
  }

  return cloneJsonObject(value);
}

function isPlainObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function escapePreviewCodePoint(codePoint: string): string {
  if (codePoint === "\n" || codePoint === "\t") {
    return codePoint;
  }

  const value = codePoint.codePointAt(0);
  if (value === undefined) {
    return codePoint;
  }

  if (value < 0x20 || value === 0x7f) {
    return `\\u${value.toString(16).padStart(4, "0")}`;
  }

  return codePoint;
}

async function reportProjectionError(
  reporter: InformationAtomLogEmergencyReporter | undefined,
  error: InformationAtomLogError,
): Promise<void> {
  try {
    await reporter?.(error);
  } catch {
    // 日志投影失败汇报不得影响原始信息原子处理。
  }
}
