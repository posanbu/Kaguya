/**
 * 架构说明：本模块定义信息原子的 wire contract，负责 JSON 负载校验、
 * 深冻结快照生成与引用结构的稳定序列化边界，避免把外部可变对象直接
 * 暴露给持久化或跨包传输层。
 * 代码库关系：`packages/schema/src/index.ts` 重新导出这里的类型与 schema，
 * 下游包通过入口消费信息原子、引用与 JSON 工具；本模块必须保持纯粹、
 * 可克隆且不依赖任何业务实现细节。
 */
import { z } from "zod";

export type JsonPrimitive = null | string | boolean | number;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export type DeepReadonly<T> = T extends (...args: readonly any[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? ReadonlyArray<DeepReadonly<U>>
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export type InformationId = z.infer<typeof informationIdSchema>;

export interface InformationReference {
  relation: string;
  informationId: InformationId;
}

export interface InformationAtom<
  K extends string = string,
  P extends JsonObject = JsonObject,
> {
  informationId: InformationId;
  kind: K;
  occurredAt: string;
  source: string;
  payload: P;
  references: InformationReference[];
}

const invalidJsonValue = Symbol("invalid-json-value");

export const informationIdSchema = z.string().trim().min(1);

export const informationReferenceSchema = z
  .object({
    relation: z.string().trim().min(1),
    informationId: informationIdSchema,
  })
  .strict();

export const jsonValueSchema = z
  .unknown()
  .transform<JsonValue>((value, context) => {
    const cloned = safelyCloneJsonValue(value);
    if (cloned === invalidJsonValue) {
      context.addIssue({
        code: "custom",
        message: "Value must contain only JSON-compatible data",
      });
      return z.NEVER;
    }
    return cloned;
  });

export const jsonObjectSchema = z
  .unknown()
  .transform<JsonObject>((value, context) => {
    const cloned = safelyCloneJsonValue(value);
    if (
      cloned === invalidJsonValue ||
      cloned === null ||
      Array.isArray(cloned) ||
      typeof cloned !== "object"
    ) {
      context.addIssue({
        code: "custom",
        message: "Value must be a JSON object",
      });
      return z.NEVER;
    }
    return cloned;
  });

export const informationAtomSchema = z
  .object({
    informationId: informationIdSchema,
    kind: z.string().trim().min(1),
    occurredAt: z.iso.datetime({ offset: true }),
    source: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$/u),
    payload: jsonObjectSchema,
    references: z.array(informationReferenceSchema),
  })
  .strict();

export function parseInformationAtom(value: unknown): DeepReadonly<InformationAtom> {
  return freezeInformationAtom(informationAtomSchema.parse(value));
}

export function freezeInformationAtom<K extends string, P extends JsonObject>(
  atom: InformationAtom<K, P>,
): DeepReadonly<InformationAtom<K, P>> {
  return deepFreeze(structuredClone(atom));
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value as DeepReadonly<T>;
  }

  Object.freeze(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    return value as DeepReadonly<T>;
  }

  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }

  return value as DeepReadonly<T>;
}

function safelyCloneJsonValue(
  value: unknown,
): JsonValue | typeof invalidJsonValue {
  try {
    return cloneJsonValue(value, new WeakSet<object>());
  } catch {
    return invalidJsonValue;
  }
}

function cloneJsonValue(
  value: unknown,
  ancestors: WeakSet<object>,
): JsonValue | typeof invalidJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : invalidJsonValue;
  }

  if (typeof value !== "object") {
    return invalidJsonValue;
  }

  if (ancestors.has(value)) {
    return invalidJsonValue;
  }

  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1
    ) {
      return invalidJsonValue;
    }

    const clone: JsonValue[] = [];
    ancestors.add(value);
    try {
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        ) {
          return invalidJsonValue;
        }

        const entry = cloneJsonValue(descriptor.value, ancestors);
        if (entry === invalidJsonValue) {
          return invalidJsonValue;
        }
        clone.push(entry);
      }
      return clone;
    } finally {
      ancestors.delete(value);
    }
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype) {
    return invalidJsonValue;
  }

  const clone: JsonObject = {};
  ancestors.add(value);
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        return invalidJsonValue;
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        return invalidJsonValue;
      }

      const entry = cloneJsonValue(descriptor.value, ancestors);
      if (entry === invalidJsonValue) {
        return invalidJsonValue;
      }
      clone[key] = entry;
    }
    return clone;
  } finally {
    ancestors.delete(value);
  }
}
