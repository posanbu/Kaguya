/**
 * 功能概述：定义唯一版本化模块协议、显式 Catalog 与受控能力边界，供模块作者和 Host 共用。
 * 主要职责：defineInformationModule 校验静态清单；Catalog 确定性合并并拒绝身份冲突；
 * capability token 保持命名空间和版本身份；onInformation 声明稳定订阅及投递语义。
 * 代码库关系：Engine 在 create 前预检这些声明，Runtime 只装配 Catalog 与 activations；
 * handler 通过受限 context 派生原子和选择上下文，无法取得裸存储或全局配置。
 * 输入输出与副作用：定义只构造冻结内存元数据，无 I/O；settings 由 Host parse 后深冻结。
 * start/stop/dispose 与 AbortSignal 表达资源生命周期；业务顺序由 information DAG 表达。
 */
import type {
  DeepReadonly,
  InformationAtom,
  InformationId,
  InformationReference,
  JsonObject,
} from "@kaguya/schema";
import { z } from "@kaguya/schema";
import {
  defineInformationKind,
  type InformationKindDefinition,
} from "./information-kind.js";
import type { InformationSelectorDefinition } from "./information-selector.js";

export interface ModuleDiagnosticDetailDefinition<
  P extends JsonObject = JsonObject,
> {
  readonly sensitivity: "metadata" | "content";
  project(payload: DeepReadonly<P>): JsonObject;
}

export interface ModuleDiagnosticDefinition<
  E extends string = string,
  P extends JsonObject = JsonObject,
> {
  readonly event: E;
  readonly message: string;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly payloadSchema: z.ZodType<P>;
  project(payload: DeepReadonly<P>): JsonObject;
  readonly detail?: ModuleDiagnosticDetailDefinition<P>;
}

export function defineModuleDiagnostic<
  const E extends string,
  P extends JsonObject,
>(
  definition: ModuleDiagnosticDefinition<E, P>,
): ModuleDiagnosticDefinition<E, P> {
  if (!/^[a-z][a-z0-9._-]*(?:\.[a-z][a-z0-9._-]*)+$/u.test(definition.event))
    throw new Error("module diagnostic event must use dotted namespace naming");
  if (typeof definition.message !== "string" || !definition.message.trim())
    throw new Error("module diagnostic message must not be empty");
  if (
    definition.level !== "debug" &&
    definition.level !== "info" &&
    definition.level !== "warn" &&
    definition.level !== "error"
  )
    throw new Error("invalid module diagnostic level");
  if (!(definition.payloadSchema instanceof z.ZodType))
    throw new Error("module diagnostic payload schema must be a Zod schema");
  const schemaDefinition =
    (definition.payloadSchema as any)._zod?.def ??
    (definition.payloadSchema as any)._def;
  const catchallDefinition =
    schemaDefinition?.catchall?._zod?.def ?? schemaDefinition?.catchall?._def;
  if (
    schemaDefinition?.type !== "object" ||
    catchallDefinition?.type !== "never"
  )
    throw new Error("module diagnostic payload schema must be a strict object");
  if (typeof definition.project !== "function")
    throw new Error("module diagnostic project must be a function");
  if (definition.detail !== undefined) {
    if (
      definition.detail.sensitivity !== "metadata" &&
      definition.detail.sensitivity !== "content"
    )
      throw new Error("invalid module diagnostic detail sensitivity");
    if (typeof definition.detail.project !== "function")
      throw new Error("module diagnostic detail project must be a function");
    Object.freeze(definition.detail);
  }
  return Object.freeze(definition);
}

export interface ModuleCapability<T = unknown> {
  readonly id: string;
  readonly apiVersion: number;
  readonly __type?: (value: T) => T;
}
export type ModuleCapabilityRequirement = ModuleCapability<any>;
export type ModuleCapabilityProvision = ModuleCapability<any>;
export interface ModuleCapabilityImplementation<T = any> {
  readonly capability: ModuleCapability<T>;
  readonly value: T;
}
export function defineModuleCapability<T>(
  id: string,
  apiVersion: number,
): ModuleCapability<T> {
  if (!/^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/u.test(id))
    throw new Error("capability id must have a namespace");
  if (!Number.isSafeInteger(apiVersion) || apiVersion < 1)
    throw new Error("invalid capability API version");
  return Object.freeze({ id, apiVersion });
}
export interface InformationPromptRendererDefinition {
  readonly rendererId: string;
  readonly displayName: string;
  readonly description: string;
  readonly kinds: readonly InformationKindDefinition<string, any>[];
  render(atom: DeepReadonly<InformationAtom>): string;
}
export interface InformationModuleManifest<TSettings = unknown> {
  readonly protocolVersion: 2;
  readonly definitionId: string;
  readonly moduleVersion: string;
  readonly displayName: string;
  readonly summary: string;
  readonly description: string;
  readonly settingsSchema: z.ZodType<TSettings>;
  readonly consumes: readonly InformationKindDefinition<string, any>[];
  readonly produces: readonly InformationKindDefinition<string, any>[];
  readonly selectors: readonly InformationSelectorDefinition[];
  readonly promptRenderers: readonly InformationPromptRendererDefinition[];
  readonly requires: readonly ModuleCapabilityRequirement[];
  readonly provides: readonly ModuleCapabilityProvision[];
  readonly diagnostics?: readonly ModuleDiagnosticDefinition<string, any>[];
}
export interface ModuleActivationProvenance {
  readonly instanceId: string;
  readonly definitionId: string;
}
export interface InformationModuleActivation extends ModuleActivationProvenance {
  readonly enabled?: boolean;
  readonly settings: unknown;
}
export interface InformationExecutionContext {
  now(): Date;
}
export interface InformationModuleCreateContext extends InformationExecutionContext {
  readonly signal: AbortSignal;
  use<T>(capability: ModuleCapability<T>): T;
  report<E extends string, P extends JsonObject>(
    definition: ModuleDiagnosticDefinition<E, P>,
    payload: P,
  ): Promise<void>;
}
export type InformationModuleLifecycleContext = InformationModuleCreateContext;
export interface ModuleRegistrationInput<P> {
  readonly payload: P;
  readonly references?: readonly InformationReference[];
  readonly contextInformationId?: InformationId;
}
export interface InformationModuleHandlerContext extends InformationModuleCreateContext {
  readonly definitionId: string;
  readonly instanceId: string;
  readonly sourceAtom: DeepReadonly<InformationAtom>;
  select(
    selector: InformationSelectorDefinition,
  ): Promise<readonly DeepReadonly<InformationAtom>[]>;
  registerOnce<K extends string, P extends JsonObject>(
    operation: string,
    key: string,
    definition: InformationKindDefinition<K, P>,
    input: ModuleRegistrationInput<P>,
  ): Promise<DeepReadonly<InformationAtom<K, P>>>;
  commitTerminal<K extends string, P extends JsonObject>(
    group: string,
    subjectInformationId: string,
    definition: InformationKindDefinition<K, P>,
    input: ModuleRegistrationInput<P>,
  ): Promise<DeepReadonly<InformationAtom>>;
  register<K extends string, P extends JsonObject>(
    definition: InformationKindDefinition<K, P>,
    input: ModuleRegistrationInput<P>,
  ): Promise<DeepReadonly<InformationAtom<K, P>>>;
}
export interface InformationModuleSubscription {
  readonly subscriptionId: string;
  readonly delivery: "live" | "durable";
  readonly kind: string;
  readonly definition: InformationKindDefinition<string, JsonObject>;
  readonly handle: (
    atom: DeepReadonly<InformationAtom>,
    context: InformationModuleHandlerContext,
  ) => Promise<void> | void;
}
export interface InformationModuleInstance {
  readonly subscriptions: readonly InformationModuleSubscription[];
  readonly provisions: readonly ModuleCapabilityImplementation[];
  start?(context: InformationModuleLifecycleContext): Promise<void> | void;
  describeStartup?():
    ModuleStartupDescription | Promise<ModuleStartupDescription>;
  stop?(): Promise<void> | void;
  dispose?(): Promise<void> | void;
}
export interface ModuleStartupDescription {
  readonly summary: string;
  readonly fields?: JsonObject;
}
export interface CreateInformationModuleInstanceOptions<TSettings> {
  readonly instanceId: string;
  readonly settings: DeepReadonly<TSettings>;
  readonly activation: ModuleActivationProvenance;
}
export interface InformationModuleDefinition<TSettings = any> {
  readonly manifest: InformationModuleManifest<TSettings>;
  create(
    options: CreateInformationModuleInstanceOptions<TSettings>,
    context: InformationModuleCreateContext,
  ): Promise<InformationModuleInstance> | InformationModuleInstance;
}
export interface InformationModuleCatalog {
  readonly definitions: readonly InformationModuleDefinition[];
}
export function defineInformationModule<TSettings>(
  definition: InformationModuleDefinition<TSettings>,
): InformationModuleDefinition<TSettings> {
  const m = definition.manifest;
  assertId(m.definitionId, "module definition id");
  if (typeof m.displayName !== "string" || !m.displayName.trim())
    throw new Error("module display name must not be empty");
  if (
    typeof m.summary !== "string" ||
    !m.summary.trim() ||
    /[\r\n]/u.test(m.summary)
  )
    throw new Error("module summary must be a non-empty single line");
  if (typeof m.description !== "string" || !m.description.trim())
    throw new Error("module description must not be empty");
  if (m.protocolVersion !== 2)
    throw new Error("unsupported information module protocol version");
  if (
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/u.test(
      m.moduleVersion,
    )
  )
    throw new Error("invalid module version");
  if (!m.settingsSchema || typeof m.settingsSchema.parse !== "function")
    throw new Error("invalid settings schema");
  for (const name of [
    "consumes",
    "produces",
    "selectors",
    "promptRenderers",
    "requires",
    "provides",
  ] as const) {
    if (!Array.isArray(m[name]))
      throw new Error(`module ${name} must be an array`);
    const ids = new Set<string>();
    for (const item of m[name]) {
      const id =
        "kind" in item
          ? item.kind
          : "selectorId" in item
            ? item.selectorId
            : "rendererId" in item
              ? item.rendererId
              : item.id;
      assertId(id, name);
      if ("kind" in item) defineInformationKind(item);
      if (ids.has(id))
        throw new Error(`Duplicate information module ${name}: ${id}`);
      ids.add(id);
      if ("apiVersion" in item)
        defineModuleCapability(item.id, item.apiVersion);
      if ("selectorId" in item && typeof item.select !== "function")
        throw new Error(`invalid Selector: ${id}`);
      if (
        "rendererId" in item &&
        (typeof item.render !== "function" ||
          !Array.isArray(item.kinds) ||
          typeof item.displayName !== "string" ||
          !item.displayName.trim() ||
          typeof item.description !== "string" ||
          !item.description.trim())
      )
        throw new Error(`invalid renderer: ${id}`);
    }
  }
  const diagnostics = m.diagnostics ?? [];
  if (!Array.isArray(diagnostics))
    throw new Error("module diagnostics must be an array");
  const diagnosticEvents = new Set<string>();
  for (const diagnostic of diagnostics) {
    defineModuleDiagnostic(diagnostic);
    if (diagnosticEvents.has(diagnostic.event))
      throw new Error(
        `Duplicate information module diagnostic: ${diagnostic.event}`,
      );
    diagnosticEvents.add(diagnostic.event);
  }
  return Object.freeze({
    ...definition,
    manifest: Object.freeze({
      ...m,
      consumes: Object.freeze([...m.consumes]),
      produces: Object.freeze([...m.produces]),
      selectors: Object.freeze(
        m.selectors.map((selector) => Object.freeze(selector)),
      ),
      promptRenderers: Object.freeze(
        m.promptRenderers.map((renderer) => {
          Object.freeze(renderer.kinds);
          return Object.freeze(renderer);
        }),
      ),
      requires: Object.freeze(
        m.requires.map((capability) => Object.freeze({ ...capability })),
      ),
      provides: Object.freeze(
        m.provides.map((capability) => Object.freeze({ ...capability })),
      ),
      diagnostics: Object.freeze([...diagnostics]),
    }),
  });
}
export function defineInformationModuleCatalog(
  ...definitions: readonly InformationModuleDefinition[]
): InformationModuleCatalog {
  const ids = new Set<string>();
  const snapshots = definitions.map((definition) =>
    defineInformationModule(definition),
  );
  for (const definition of snapshots) {
    const id = definition.manifest.definitionId;
    if (ids.has(id))
      throw new Error(`Duplicate information module definition id: ${id}`);
    ids.add(id);
  }
  return Object.freeze({
    definitions: Object.freeze(
      [...snapshots].sort((a, b) =>
        a.manifest.definitionId.localeCompare(b.manifest.definitionId),
      ),
    ),
  });
}
export function mergeInformationModuleCatalogs(
  ...catalogs: readonly InformationModuleCatalog[]
): InformationModuleCatalog {
  return defineInformationModuleCatalog(
    ...catalogs.flatMap((c) => c.definitions),
  );
}
export function catalogInformationKinds(
  catalog: InformationModuleCatalog,
): readonly InformationKindDefinition<string, any>[] {
  const kinds = new Map<string, InformationKindDefinition<string, any>>();
  for (const { manifest } of catalog.definitions)
    for (const kind of [...manifest.consumes, ...manifest.produces]) {
      const prior = kinds.get(kind.kind);
      if (prior && prior !== kind)
        throw new Error(`Information kind definition mismatch: ${kind.kind}`);
      kinds.set(kind.kind, kind);
    }
  return [...kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind));
}
export function onInformation<K extends string, P extends JsonObject>(
  definition: InformationKindDefinition<K, P>,
  options: {
    readonly subscriptionId: string;
    readonly delivery: "live" | "durable";
  },
  handle: (
    atom: DeepReadonly<InformationAtom<K, P>>,
    context: InformationModuleHandlerContext,
  ) => Promise<void> | void,
): InformationModuleSubscription {
  assertId(options.subscriptionId, "subscription id");
  if (options.delivery !== "live" && options.delivery !== "durable")
    throw new Error("invalid subscription delivery");
  return Object.freeze({
    ...options,
    kind: definition.kind,
    definition:
      definition as unknown as InformationModuleSubscription["definition"],
    handle: handle as InformationModuleSubscription["handle"],
  });
}
function assertId(value: string, label: string): void {
  if (typeof value !== "string" || !/^[a-z][a-z0-9._:-]*$/u.test(value))
    throw new Error(`${label} must be a stable namespaced identifier`);
}
