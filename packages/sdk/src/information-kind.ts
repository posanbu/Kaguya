/**
 * 架构说明：本模块定义信息 kind 的声明契约、引用规则、日志策略与追加输入，
 * 供 Core 启动前完成注册并在后续追加路径中复用同一套校验与冻结快照逻辑。
 * 代码库关系：`packages/sdk/src/index.ts` 通过此模块向外暴露 `defineInformationKind`
 * 与相关类型；`packages/engine` 会在 Registry 生命周期中消费这些定义。
 */
import { type InformationAtom, type JsonObject, z } from "@kaguya/schema";

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

export interface InformationLogEnabledPolicy<P extends JsonObject = JsonObject> {
  readonly enabled: true;
  readonly level: InformationLogLevel;
  readonly project: (atom: InformationAtom<string, P>) => InformationLogProjection;
}

export type InformationLogPolicy<P extends JsonObject = JsonObject> =
  | InformationLogDisabledPolicy
  | InformationLogEnabledPolicy<P>;

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

  const references = cloneAndValidateReferenceRules(input.references);
  const log = cloneAndValidateLogPolicy(input.log);

  return Object.freeze({
    kind: input.kind,
    payloadSchema: input.payloadSchema,
    references,
    log,
  });
}

function assertKindName(kind: string): void {
  if (!kindNamePattern.test(kind)) {
    throw new Error("kind must use dotted namespace naming");
  }
}

function assertPayloadSchema(payloadSchema: unknown): asserts payloadSchema is z.ZodType<JsonObject> {
  if (!(payloadSchema instanceof z.ZodType)) {
    throw new Error("payload schema must be a Zod schema");
  }
  if (!(payloadSchema instanceof z.ZodObject)) {
    throw new Error("payload schema must be a strict JSON object schema");
  }

  const candidate = buildRepresentativeObject(payloadSchema);
  const probe = {
    ...candidate,
    __kaguya_payload_probe__: "__kaguya_probe__",
  };

  if (payloadSchema.safeParse(probe).success) {
    throw new Error(
      "payload schema must reject unknown keys and produce a JSON object",
    );
  }
}

function buildRepresentativeObject(
  schema: z.ZodObject<z.ZodRawShape>,
): Record<string, unknown> {
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  const result: Record<string, unknown> = {};
  for (const [key, fieldSchema] of Object.entries(shape)) {
    const value = buildRepresentativeValue(fieldSchema);
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function buildRepresentativeValue(schema: z.ZodTypeAny): unknown {
  if (schema instanceof z.ZodString) {
    return "probe";
  }
  if (schema instanceof z.ZodNumber) {
    return 0;
  }
  if (schema instanceof z.ZodBoolean) {
    return true;
  }
  if (schema instanceof z.ZodBigInt) {
    return undefined;
  }
  if (schema instanceof z.ZodLiteral) {
    return (schema as any).value;
  }
  if (schema instanceof z.ZodEnum) {
    return (schema as any).options[0];
  }
  if (schema instanceof z.ZodArray) {
    const element = buildRepresentativeValue((schema as any).element);
    return element === undefined ? undefined : [element];
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return buildRepresentativeValue((schema as any).unwrap());
  }
  if (schema instanceof z.ZodDefault) {
    return buildRepresentativeValue((schema as any).removeDefault());
  }
  if (schema instanceof z.ZodObject) {
    return buildRepresentativeObject(schema as any);
  }
  return undefined;
}

function cloneAndValidateReferenceRules(
  references: Record<string, InformationReferenceRuleInput>,
): Readonly<Record<string, InformationReferenceRule>> {
  if (typeof references !== "object" || references === null || Array.isArray(references)) {
    throw new Error("reference rules must be an object");
  }

  const cloned: Record<string, InformationReferenceRule> = {};

  for (const [relation, rule] of Object.entries(references)) {
    assertRelationName(relation);
    if (typeof rule !== "object" || rule === null) {
      throw new Error(`reference rule must be an object: ${relation}`);
    }
    if (typeof rule.required !== "boolean") {
      throw new Error(`reference rule required flag must be boolean: ${relation}`);
    }
    if (typeof rule.multiple !== "boolean") {
      throw new Error(`reference rule multiple flag must be boolean: ${relation}`);
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
          throw new Error(`reference targetKinds must not contain duplicates: ${relation}`);
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
