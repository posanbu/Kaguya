/**
 * 功能概述：定义可独立发布的信息模块插件，以及可持久保存的版本化 Kind 契约。
 * 主要职责：defineModulePlugin 冻结插件身份、模块目录和模型能力申请；defineVersionedInformationKind
 * 将 owner、版本、JSON Schema 与引用规则绑定到不可复用的 Kind 名称；readCompatibleInformation
 * 只在读取时按插件显式规则转换 payload，并用目标 schema 校验结果，绝不改写历史 Atom。
 * 代码库关系：Composition 从 npm/本地包导入声明，Engine/Database 保存 persistence 元数据；
 * 插件只能申请宿主已提供的能力，模块执行仍由 ModuleHost 负责。
 * 输入输出与副作用：声明阶段无 I/O；拒绝 core 命名空间、非 JSON Schema 和错配的版本后缀。
 */
import {
  z,
  type DeepReadonly,
  type InformationAtom,
  type JsonObject,
} from "@kaguya/schema";
import {
  defineInformationKind,
  type DefineInformationKindInput,
  type InformationKindDefinition,
} from "./information-kind.js";
import {
  defineInformationModuleCatalog,
  type InformationModuleDefinition,
  type InformationModuleCatalog,
} from "./modules.js";

export interface InformationKindPersistence {
  readonly owner: string;
  readonly version: number;
  readonly schema: JsonObject;
}

export interface InformationModulePlugin {
  readonly apiVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly catalog: InformationModuleCatalog;
  /** 声明所需模型档位；宿主仍负责模型选择、凭据与调用授权。 */
  readonly modelTasks: Readonly<Record<string, "light" | "heavy">>;
  readonly compatibility: readonly InformationKindCompatibility[];
}

export interface InformationKindCompatibility {
  readonly from: InformationKindDefinition<string, any>;
  readonly to: InformationKindDefinition<string, any>;
  readonly convert: (payload: any) => JsonObject;
}

/** 声明工厂只获得宿主的稳定 Kind 身份，不持有 Core、数据库或运行中实例。 */
export interface ModulePluginHost {
  kind(name: string): InformationKindDefinition<string, any>;
}
export type InformationModulePluginFactory = (
  host: ModulePluginHost,
) => InformationModulePlugin;

export function defineModulePlugin(input: {
  readonly id: string;
  readonly version: string;
  readonly modules: readonly InformationModuleDefinition[];
  readonly modelTasks?: Readonly<Record<string, "light" | "heavy">>;
  readonly compatibility?: readonly InformationKindCompatibility[];
}): InformationModulePlugin {
  if (
    !/^[a-z][a-z0-9.-]+$/u.test(input.id) ||
    !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/u.test(input.version)
  )
    throw new Error("Invalid module plugin identity or version");
  const catalog = defineInformationModuleCatalog(...input.modules);
  const pairs = new Set<string>();
  for (const rule of input.compatibility ?? []) {
    const pair = `${rule.from.kind}:${rule.to.kind}`;
    if (
      pairs.has(pair) ||
      rule.from.kind === rule.to.kind ||
      typeof rule.convert !== "function" ||
      rule.from.persistence?.owner !== input.id ||
      rule.to.persistence?.owner !== input.id ||
      !catalog.definitions.some(({ manifest }) =>
        [...manifest.consumes, ...manifest.produces].includes(rule.to),
      )
    )
      throw new Error(`Invalid plugin compatibility declaration: ${pair}`);
    pairs.add(pair);
  }
  for (const [id, tier] of Object.entries(input.modelTasks ?? {})) {
    if (
      !catalog.definitions.some(
        ({ manifest }) =>
          manifest.definitionId === id &&
          manifest.requires.some((c) => c.id === "kaguya:model-task"),
      ) ||
      !["light", "heavy"].includes(tier)
    )
      throw new Error(`Invalid plugin model task declaration: ${id}`);
  }
  return Object.freeze({
    apiVersion: 1,
    id: input.id,
    version: input.version,
    catalog,
    modelTasks: Object.freeze({ ...input.modelTasks }),
    compatibility: Object.freeze(
      (input.compatibility ?? []).map((rule) => Object.freeze({ ...rule })),
    ),
  });
}

/** 按插件清单选择兼容规则，原子 ID/Kind 与持久 payload 均不发生变化。 */
export function readPluginInformation(
  plugin: InformationModulePlugin,
  atom: DeepReadonly<InformationAtom>,
  targetKind: string,
): DeepReadonly<JsonObject> {
  const target = plugin.catalog.definitions
    .flatMap(({ manifest }) => [...manifest.consumes, ...manifest.produces])
    .find((kind) => kind.kind === targetKind);
  if (!target)
    throw new Error(`Plugin does not declare target Kind: ${targetKind}`);
  return readCompatibleInformation(
    atom,
    target,
    plugin.compatibility.filter((rule) => rule.to === target),
  );
}

export function defineVersionedInformationKind<
  const K extends string,
  P extends JsonObject,
>(
  input: DefineInformationKindInput<K, P> & {
    readonly owner: string;
    readonly version: number;
  },
): InformationKindDefinition<K, P> {
  if (
    !/^[a-z][a-z0-9.-]+$/u.test(input.owner) ||
    !Number.isSafeInteger(input.version) ||
    input.version < 1
  )
    throw new Error("Invalid information kind owner or version");
  if (
    input.kind.startsWith("core.") ||
    !input.kind.endsWith(`.v${input.version}`)
  )
    throw new Error("Plugin information kind must have its version suffix");
  const definition = defineInformationKind(input);
  const schema = JSON.parse(
    JSON.stringify(z.toJSONSchema(input.payloadSchema)),
  ) as JsonObject;
  return Object.freeze({
    ...definition,
    persistence: freezeJson({
      owner: input.owner,
      version: input.version,
      schema,
    }),
  });
}

export function readCompatibleInformation<P extends JsonObject>(
  atom: DeepReadonly<InformationAtom>,
  target: InformationKindDefinition<string, P>,
  readers: readonly {
    readonly from: InformationKindDefinition<string, any>;
    readonly convert: (payload: any) => P;
  }[],
): DeepReadonly<P> {
  if (atom.kind === target.kind)
    return freezeJson(
      target.payloadSchema.parse(atom.payload),
    ) as DeepReadonly<P>;
  const reader = readers.find(({ from }) => from.kind === atom.kind);
  if (!reader)
    throw new Error(`Unsupported information kind version: ${atom.kind}`);
  return freezeJson(
    target.payloadSchema.parse(
      reader.convert(reader.from.payloadSchema.parse(atom.payload)),
    ),
  ) as DeepReadonly<P>;
}

function freezeJson<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
