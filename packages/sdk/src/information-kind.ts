/**
 * 架构说明：本模块定义信息 kind 的声明契约、引用规则、日志策略与注册输入，并以
 * 当前递归路径校验 JSON schema，使 pipe 可安全复用同一个非递归子 schema。
 * 代码库关系：`packages/sdk/src/index.ts` 通过此模块向外暴露 `defineInformationKind`
 * 与相关类型；`packages/engine` 会在 Registry 生命周期中消费这些定义。
 */
import {
  type InformationAtom,
  type InformationReference,
  type JsonObject,
  z,
} from "@kaguya/schema";

export type InformationLogLevel = "debug" | "info" | "warn" | "error";

export type InformationLogProjection = JsonObject;

export interface InformationReferenceRule {
  readonly required: boolean;
  readonly multiple: boolean;
  readonly targetKinds?: readonly string[];
}

export interface InformationLogDisabledPolicy {
  readonly enabled: false;
}

export interface InformationLogEnabledPolicy<
  P extends JsonObject = JsonObject,
> {
  readonly enabled: true;
  readonly level: InformationLogLevel;
  readonly project: (
    atom: InformationAtom<string, P>,
  ) => InformationLogProjection;
}

export type InformationLogPolicy<P extends JsonObject = JsonObject> =
  InformationLogDisabledPolicy | InformationLogEnabledPolicy<P>;

export interface InformationKindDefinition<
  K extends string,
  P extends JsonObject,
> {
  readonly kind: K;
  readonly payloadSchema: z.ZodType<P>;
  readonly references: Readonly<Record<string, InformationReferenceRule>>;
  readonly log: InformationLogPolicy<P>;
}

export interface DefineInformationKindInput<
  K extends string,
  P extends JsonObject,
> {
  readonly kind: K;
  readonly payloadSchema: z.ZodType<P>;
  readonly references: Record<string, InformationReferenceRuleInput>;
  readonly log: InformationLogPolicy<P>;
}

export interface InformationReferenceRuleInput {
  readonly required: boolean;
  readonly multiple: boolean;
  readonly targetKinds?: readonly string[];
}

export type InformationAppendInput<
  K extends string,
  P extends JsonObject,
> = Omit<InformationAtom<K, P>, "informationId">;

/**
 * 提交新信息原子的公开输入。kind 和 informationId 分别由 definition 与 Core
 * 唯一确定，调用方不能伪造或重复携带它们。
 */
export type InformationRegistrationInput<
  K extends string,
  P extends JsonObject,
> = {
  readonly occurredAt: string;
  readonly source: string;
  readonly payload: P;
  readonly references: readonly InformationReference[];
};

const kindNamePattern = /^[a-z][a-z0-9._-]*(?:\.[a-z][a-z0-9._-]*)+$/u;
const relationNamePattern =
  /^(?:core:[a-z][a-z0-9._-]*|[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*)$/u;

export function defineInformationKind<
  const K extends string,
  P extends JsonObject,
>(input: DefineInformationKindInput<K, P>): InformationKindDefinition<K, P> {
  if (typeof input !== "object" || input === null) {
    throw new Error("information kind definition must be an object");
  }
  assertKindName(input.kind);
  assertPayloadSchema(input.payloadSchema);

  return Object.freeze({
    kind: input.kind,
    payloadSchema: input.payloadSchema,
    references: cloneAndValidateReferenceRules(input.references),
    log: cloneAndValidateLogPolicy(input.log),
  });
}

function assertKindName(kind: string): void {
  if (!kindNamePattern.test(kind)) {
    throw new Error("kind must use dotted namespace naming");
  }
}

function assertPayloadSchema(
  payloadSchema: unknown,
): asserts payloadSchema is z.ZodType<JsonObject> {
  if (!(payloadSchema instanceof z.ZodType)) {
    throw new Error("payload schema must be a Zod schema");
  }
  assertJsonObjectSchema(payloadSchema as any, new Set<any>());
}

function assertJsonObjectSchema(schema: any, seen: Set<any>): void {
  const def = getSchemaDef(schema);
  switch (def.type) {
    case "object":
      assertStrictObjectSchema(def, seen);
      return;
    case "union":
    case "discriminatedUnion":
    case "xor":
      for (const option of getSchemaOptions(def)) {
        assertJsonObjectSchema(option, seen);
      }
      return;
    case "intersection":
      assertJsonObjectSchema(def.left, seen);
      assertJsonObjectSchema(def.right, seen);
      return;
    case "pipe":
    case "transform": {
      const inputSchema = def.in ?? def.innerType ?? def.input;
      const sample =
        inputSchema === undefined
          ? undefined
          : buildRepresentativeValue(inputSchema, seen);
      if (sample === undefined) {
        throw new Error("payload schema must produce a JSON object");
      }
      const parsed = schema.safeParse(sample);
      if (!parsed.success || !isPlainJsonObject(parsed.data)) {
        throw new Error("payload schema must produce a JSON object");
      }
      assertJsonCompatibleValue(parsed.data);
      return;
    }
    case "record":
      assertRecordKeySchema(def.keyType);
      assertJsonValue(def.valueType, seen);
      return;
    default:
      throw new Error("payload schema must produce a JSON object");
  }
}

function assertStrictObjectSchema(def: any, seen: Set<any>): void {
  if (!isNeverSchema(def.catchall)) {
    throw new Error("payload schema must be strict");
  }

  const shape = getObjectShape(def);
  for (const fieldSchema of Object.values(shape)) {
    assertJsonValue(fieldSchema, seen);
  }
}

function assertJsonValue(schema: any, seen: Set<any>): void {
  const def = getSchemaDef(schema);
  switch (def.type) {
    case "string":
    case "number":
    case "boolean":
    case "null":
    case "literal":
    case "enum":
      return;
    case "array":
      assertJsonValue(def.element, seen);
      return;
    case "tuple":
      for (const item of Array.isArray(def.items) ? def.items : []) {
        assertJsonValue(item, seen);
      }
      if (def.rest !== undefined) {
        assertJsonValue(def.rest, seen);
      }
      return;
    case "object":
      assertStrictObjectSchema(def, seen);
      return;
    case "record":
      assertRecordKeySchema(def.keyType);
      assertJsonValue(def.valueType, seen);
      return;
    case "union":
    case "discriminatedUnion":
    case "xor":
      for (const option of getSchemaOptions(def)) {
        assertJsonValue(option, seen);
      }
      return;
    case "intersection":
      assertJsonValue(def.left, seen);
      assertJsonValue(def.right, seen);
      return;
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "nonoptional":
    case "readonly":
    case "catch":
    case "success":
      assertJsonValue(def.innerType, seen);
      return;
    case "pipe":
    case "transform":
      assertJsonValueOrObjectViaParse(schema, def, seen);
      return;
    case "bigint":
    case "date":
    case "symbol":
    case "undefined":
    case "void":
    case "file":
    case "nan":
    case "map":
    case "set":
    case "function":
    case "promise":
    case "custom":
      throw new Error(`payload schema contains unsupported ${def.type} fields`);
    default:
      throw new Error(
        `payload schema contains unsupported ${String(def.type)} fields`,
      );
  }
}

function assertJsonValueOrObjectViaParse(
  schema: any,
  def: any,
  seen: Set<any>,
): void {
  const inputSchema = def.in ?? def.innerType ?? def.input;
  const sample =
    inputSchema === undefined
      ? undefined
      : buildRepresentativeValue(inputSchema, seen);
  if (sample === undefined) {
    throw new Error("payload schema must produce a JSON-compatible value");
  }

  const parsed = schema.safeParse(sample);
  if (!parsed.success) {
    throw new Error("payload schema must produce a JSON-compatible value");
  }
  assertJsonCompatibleValue(parsed.data);
}

function assertJsonCompatibleValue(value: unknown): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertJsonCompatibleValue(item);
    }
    return;
  }
  if (isPlainJsonObject(value)) {
    for (const item of Object.values(value)) {
      assertJsonCompatibleValue(item);
    }
    return;
  }
  throw new Error("payload schema must produce JSON-compatible output");
}

function buildRepresentativeValue(schema: any, seen: Set<any>): unknown {
  if (seen.has(schema)) {
    return undefined;
  }
  seen.add(schema);

  try {
    const def = getSchemaDef(schema);
    switch (def.type) {
      case "string":
        return "probe";
      case "number":
        return 0;
      case "boolean":
        return true;
      case "null":
        return null;
      case "literal":
        return getLiteralValue(def);
      case "enum":
        return getEnumValue(def);
      case "bigint":
        return 1n;
      case "date":
        return new Date("2026-09-01T00:00:00.000Z");
      case "array": {
        const item = buildRepresentativeValue(def.element, seen);
        return item === undefined ? [] : [item];
      }
      case "tuple":
        return (Array.isArray(def.items) ? def.items : []).map((item: any) =>
          buildRepresentativeValue(item, seen),
        );
      case "object": {
        const shape = getObjectShape(def);
        const result: Record<string, unknown> = {};
        for (const [key, fieldSchema] of Object.entries(shape)) {
          const value = buildRepresentativeValue(fieldSchema, seen);
          if (value !== undefined) {
            result[key] = value;
          }
        }
        return result;
      }
      case "record": {
        const value = buildRepresentativeValue(def.valueType, seen);
        return value === undefined ? {} : { probe: value };
      }
      case "union":
      case "discriminatedUnion":
      case "xor": {
        const [firstOption] = getSchemaOptions(def);
        return firstOption === undefined
          ? undefined
          : buildRepresentativeValue(firstOption, seen);
      }
      case "intersection": {
        const left = buildRepresentativeValue(def.left, seen);
        const right = buildRepresentativeValue(def.right, seen);
        if (isPlainJsonObject(left) && isPlainJsonObject(right)) {
          return { ...left, ...right };
        }
        return left ?? right;
      }
      case "optional":
      case "nullable":
      case "default":
      case "prefault":
      case "nonoptional":
      case "readonly":
      case "catch":
      case "success":
        return buildRepresentativeValue(def.innerType, seen);
      case "pipe":
      case "transform": {
        const inputSchema = def.in ?? def.innerType ?? def.input;
        return inputSchema === undefined
          ? undefined
          : buildRepresentativeValue(inputSchema, seen);
      }
      default:
        return undefined;
    }
  } finally {
    seen.delete(schema);
  }
}

function getSchemaDef(schema: any): any {
  return schema?._zod?.def ?? schema?.def ?? {};
}

function getSchemaOptions(def: any): readonly any[] {
  const options = def.options ?? def.innerTypes ?? def.items;
  return Array.isArray(options) ? options : [];
}

function getObjectShape(def: any): Record<string, any> {
  const shape = def.shape;
  if (typeof shape === "function") {
    return shape();
  }
  if (shape && typeof shape === "object") {
    return shape;
  }
  return {};
}

function assertRecordKeySchema(keySchema: any): void {
  const def = getSchemaDef(keySchema);
  if (def.type !== "string" && def.type !== "literal" && def.type !== "enum") {
    throw new Error("record keys must be JSON string keys");
  }
}

function isNeverSchema(schema: any): boolean {
  return Boolean(schema) && getSchemaDef(schema).type === "never";
}

function isPlainJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.getPrototypeOf(value) === Object.prototype;
}

function getLiteralValue(def: any): unknown {
  if (Array.isArray(def.values) && def.values.length > 0) {
    return def.values[0];
  }
  return def.value;
}

function getEnumValue(def: any): unknown {
  if (def.entries && typeof def.entries === "object") {
    const values = Object.values(def.entries);
    if (values.length > 0) {
      return values[0];
    }
  }
  return Array.isArray(def.options) ? def.options[0] : undefined;
}

function cloneAndValidateReferenceRules(
  references: Record<string, InformationReferenceRuleInput>,
): Readonly<Record<string, InformationReferenceRule>> {
  if (
    typeof references !== "object" ||
    references === null ||
    Array.isArray(references)
  ) {
    throw new Error("reference rules must be an object");
  }

  const cloned: Record<string, InformationReferenceRule> = {};

  for (const [relation, rule] of Object.entries(references)) {
    assertRelationName(relation);
    if (typeof rule !== "object" || rule === null) {
      throw new Error(`reference rule must be an object: ${relation}`);
    }
    if (typeof rule.required !== "boolean") {
      throw new Error(
        `reference rule required flag must be boolean: ${relation}`,
      );
    }
    if (typeof rule.multiple !== "boolean") {
      throw new Error(
        `reference rule multiple flag must be boolean: ${relation}`,
      );
    }

    const targetKinds = rule.targetKinds;
    let clonedTargetKinds: readonly string[] | undefined;
    if (targetKinds !== undefined) {
      if (!Array.isArray(targetKinds)) {
        throw new Error(`reference targetKinds must be an array: ${relation}`);
      }
      if (targetKinds.length === 0) {
        throw new Error(`reference targetKinds must not be empty: ${relation}`);
      }

      const targetKindSet = new Set<string>();
      const normalizedTargetKinds: string[] = [];
      for (const targetKind of targetKinds) {
        assertKindName(targetKind);
        if (targetKindSet.has(targetKind)) {
          throw new Error(
            `reference targetKinds must not contain duplicates: ${relation}`,
          );
        }
        targetKindSet.add(targetKind);
        normalizedTargetKinds.push(targetKind);
      }
      clonedTargetKinds = Object.freeze(normalizedTargetKinds);
    }

    cloned[relation] = Object.freeze(
      clonedTargetKinds === undefined
        ? {
            required: rule.required,
            multiple: rule.multiple,
          }
        : {
            required: rule.required,
            multiple: rule.multiple,
            targetKinds: clonedTargetKinds,
          },
    );
  }

  return Object.freeze(cloned);
}

function cloneAndValidateLogPolicy<P extends JsonObject>(
  log: InformationLogPolicy<P>,
): InformationLogPolicy<P> {
  if (typeof log !== "object" || log === null) {
    throw new Error("log policy must be explicit");
  }
  if (log.enabled === false) {
    return Object.freeze({ enabled: false });
  }

  if (log.enabled !== true) {
    throw new Error("log policy must be explicit");
  }

  if (
    log.level !== "debug" &&
    log.level !== "info" &&
    log.level !== "warn" &&
    log.level !== "error"
  ) {
    throw new Error("log level must be one of debug, info, warn, error");
  }
  if (typeof log.project !== "function") {
    throw new Error("log project must be a function");
  }

  return Object.freeze({
    enabled: true,
    level: log.level,
    project: log.project,
  });
}

function assertRelationName(relation: string): void {
  if (!relationNamePattern.test(relation)) {
    throw new Error("reference relation must use a namespace");
  }
}
