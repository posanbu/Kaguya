/**
 * 功能概述：按唯一 SDK Catalog 协议预检并托管模块，严格隔离声明能力与业务原子。
 * 主要职责：preflight 在任何 create 前验证配置、kind、Selector、renderer 和能力图；
 * start 按确定性拓扑顺序创建/启动，全部成功后开放订阅；失败逆序 stop/dispose。
 * 代码库关系：Runtime 先把 catalogInformationKinds 注册到 Core，再调用本宿主；
 * durable 订阅由 Core 的 ReliableInformationRunner 执行并受 claim fencing 保护；
 * SDK 的 use/select/registerOnce/commitTerminal 始终受清单约束，Core 负责最终原子验证与故障事实。
 * 输入输出与副作用：设置 parse 后深冻结；回滚取消全部 prepared activation，关闭有界排空 live handler；
 * 每个 stop/dispose hook 都受 drainTimeoutMs 限制，超时记录实例与钩子名称并继续逆序清理，
 * 拒绝迟到写入并聚合清理错误；inspect 仅包含哈希、身份、声明与绑定，不暴露配置值。
 */
import { createHash } from "node:crypto";
import {
  z,
  type DeepReadonly,
  type InformationAtom,
  type InformationReference,
  type JsonObject,
  type JsonValue,
} from "@kaguya/schema";
import {
  catalogInformationKinds,
  defineInformationModuleCatalog,
  type InformationKindDefinition,
  type InformationModuleActivation,
  type InformationModuleCatalog,
  type InformationModuleDefinition,
  type InformationModuleHandlerContext,
  type InformationModuleInstance,
  type InformationModuleCreateContext,
  type ModuleDiagnosticDefinition,
  type ModuleStartupDescription,
  type ModuleCapability,
  type ModuleCapabilityImplementation,
  type ModuleRegistrationInput,
  type InformationModuleSubscription,
} from "@kaguya/sdk";
import { InformationCore } from "./information-core.js";
export interface ModuleHostOptions {
  readonly core: InformationCore;
  readonly catalog: InformationModuleCatalog;
  readonly capabilities?: readonly ModuleCapabilityImplementation[];
  readonly now?: () => Date;
  readonly drainTimeoutMs?: number;
  readonly observer?: ModuleHostObserver;
}
export interface ModuleHostObservation {
  readonly category: "lifecycle" | "diagnostic" | "diagnostic-rejected";
  readonly event: string;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly definitionId?: string;
  readonly instanceId?: string;
  readonly sourceInformationId?: string;
  readonly contextInformationId?: string;
  readonly fields?: JsonObject;
  readonly diagnostic?: {
    readonly definition: ModuleDiagnosticDefinition<string, JsonObject>;
    readonly payload: DeepReadonly<JsonObject>;
  };
}
export type ModuleHostObserver = (
  observation: ModuleHostObservation,
) => void | Promise<void>;
export class ModuleDefinitionNotFoundError extends Error {
  constructor(readonly definitionId: string) {
    super(`Information module definition is not registered: ${definitionId}`);
    this.name = "ModuleDefinitionNotFoundError";
  }
}
export class ModuleKindNotDeclaredError extends Error {
  constructor(
    readonly definitionId: string,
    readonly kind: string,
  ) {
    super(
      `Information module kind is not declared: ${definitionId} -> ${kind}`,
    );
    this.name = "ModuleKindNotDeclaredError";
  }
}
interface PreparedModule {
  readonly definition: InformationModuleDefinition;
  readonly instanceId: string;
  readonly settings: unknown;
  readonly controller: AbortController;
}
interface ActiveInformationModule extends PreparedModule {
  readonly instance: InformationModuleInstance;
  subscriptions: readonly InformationModuleSubscription[];
  provisions: readonly ModuleCapabilityImplementation[];
}
export class ModuleHost {
  readonly #options: ModuleHostOptions;
  readonly #active: ActiveInformationModule[] = [];
  readonly #controllers = new Set<AbortController>();
  readonly #unsubscribe: Array<() => void> = [];
  readonly #inFlight = new Set<Promise<unknown>>();
  readonly #values = new Map<string, ModuleCapabilityImplementation>();
  readonly #bindings = new Map<string, Map<string, string>>();
  #state: "new" | "starting" | "started" | "stopping" | "stopped" = "new";
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  readonly #startupRollbackFailures: unknown[] = [];
  constructor(options: ModuleHostOptions) {
    this.#options = options;
    if (
      !Number.isFinite(options.drainTimeoutMs ?? 5000) ||
      (options.drainTimeoutMs ?? 5000) < 0
    )
      throw new Error("invalid module drain timeout");
  }
  start(activations: readonly InformationModuleActivation[]): Promise<void> {
    if (this.#state === "starting") return this.#startPromise!;
    if (this.#state === "started") return Promise.resolve();
    if (this.#state !== "new")
      return Promise.reject(new Error("ModuleHost cannot be restarted"));
    this.#state = "starting";
    this.#startPromise = this.startHost(activations);
    return this.#startPromise;
  }
  private async startHost(
    activations: readonly InformationModuleActivation[],
  ): Promise<void> {
    let current: PreparedModule | undefined;
    let phase = "preflight";
    try {
      const prepared = this.preflight(activations);
      await this.observe({
        category: "lifecycle",
        event: "modules.assembled",
        level: "info",
        message: "Information modules assembled",
        fields: {
          moduleCount: prepared.length,
          order: prepared.map(({ definition, instanceId }) => ({
            definitionId: definition.manifest.definitionId,
            instanceId,
          })),
        },
      });
      for (const module of prepared) this.#controllers.add(module.controller);
      for (const activation of prepared) {
        current = activation;
        this.assertStarting();
        const context = this.createLifecycleContext(activation);
        await this.observe(
          moduleLifecycleObservation(
            "module.starting",
            "info",
            "Information module starting",
            activation,
            { phase: "create" },
          ),
        );
        phase = "create";
        const instance = await activation.definition.create(
          {
            instanceId: activation.instanceId,
            settings: activation.settings,
            activation: Object.freeze({
              instanceId: activation.instanceId,
              definitionId: activation.definition.manifest.definitionId,
            }),
          },
          context,
        );
        const active: ActiveInformationModule = {
          ...activation,
          instance,
          subscriptions: [],
          provisions: [],
        };
        this.#active.push(active);
        this.assertStarting();
        phase = "validate";
        this.validateInstance(active);
        for (const value of active.provisions)
          this.#values.set(value.capability.id, value);
        phase = "start";
        await instance.start?.(context);
        this.assertStarting();
        let startup: ModuleStartupDescription | undefined;
        let statusFailure: string | undefined;
        if (instance.describeStartup !== undefined) {
          try {
            startup = validateStartupDescription(
              await instance.describeStartup(),
            );
          } catch (error) {
            statusFailure = safeErrorType(error);
          }
        }
        await this.observe(
          moduleLifecycleObservation(
            "module.started",
            "info",
            startup?.summary ?? "Information module started",
            activation,
            { ...(startup?.fields ?? {}) },
          ),
        );
        if (statusFailure !== undefined) {
          await this.observe(
            moduleLifecycleObservation(
              "module.status.failed",
              "warn",
              "Information module startup status failed",
              activation,
              { errorType: statusFailure },
            ),
          );
        }
        current = undefined;
      }
      // 所有 create/start 均成功之后，才安装任何业务订阅。
      phase = "subscriptions";
      for (const module of this.#active)
        for (const subscription of module.subscriptions) {
          if (subscription.delivery === "durable") {
            this.#unsubscribe.push(
              this.#options.core.onDurable(
                `${module.instanceId}:${subscription.subscriptionId}`,
                subscription.definition,
                (atom, signal) =>
                  this.trackHandler(() =>
                    subscription.handle(
                      atom,
                      this.createContext(module, atom, signal),
                    ),
                  ).then(() => undefined),
              ),
            );
          } else {
            this.#unsubscribe.push(
              this.#options.core.on(
                subscription.definition,
                {
                  consumerId: `module:${module.instanceId}:${subscription.subscriptionId}`,
                  definitionId: module.definition.manifest.definitionId,
                  instanceId: module.instanceId,
                },
                (atom) =>
                  this.trackHandler(() =>
                    subscription.handle(atom, this.createContext(module, atom)),
                  ),
              ),
            );
          }
        }
      phase = "reliable-delivery";
      await this.#options.core.startReliableDelivery();
      this.assertStarting();
      this.#state = "started";
    } catch (error) {
      if (current !== undefined) {
        await this.observe(
          moduleLifecycleObservation(
            "module.start.failed",
            "error",
            "Information module failed to start",
            current,
            { phase, errorType: safeErrorType(error) },
          ),
        );
      }
      await this.observe({
        category: "lifecycle",
        event: "modules.start.failed",
        level: "error",
        message: "Information module startup failed",
        fields: {
          phase,
          errorType: safeErrorType(error),
          ...(current === undefined
            ? {}
            : {
                definitionId: current.definition.manifest.definitionId,
                instanceId: current.instanceId,
              }),
        },
      });
      for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
      await this.#options.core.stopReliableDelivery();
      const failures = await this.cleanup();
      this.#startupRollbackFailures.push(...failures);
      if (this.#state === "starting") this.#state = "stopped";
      if (failures.length)
        throw new AggregateError(
          [error, ...failures],
          "Information module startup failed during rollback",
        );
      throw error;
    }
  }
  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    if (this.#state === "stopped") return Promise.resolve();
    const starting =
      this.#state === "starting" ? this.#startPromise : undefined;
    this.#state = "stopping";
    const stopDelivery = this.#options.core.stopReliableDelivery();
    for (const controller of this.#controllers) controller.abort();
    this.#stopPromise = (async () => {
      await starting?.catch(() => undefined);
      await stopDelivery;
      for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
      const failures = [
        ...this.#startupRollbackFailures.splice(0),
        ...(await this.cleanup()),
      ];
      this.#state = "stopped";
      if (failures.length)
        throw new AggregateError(
          failures,
          "One or more information modules failed to stop",
        );
    })();
    return this.#stopPromise;
  }
  private async cleanup(): Promise<unknown[]> {
    // create 抛出时尚未进入 active，但其已获得的 signal 同样必须取消。
    for (const controller of this.#controllers) controller.abort();
    const modules = this.#active.splice(0).reverse(),
      failures: unknown[] = [];
    for (const module of modules)
      try {
        await runCleanupHook(
          module,
          "stop",
          this.#options.drainTimeoutMs ?? 5000,
        );
      } catch (error) {
        failures.push(error);
      }
    await boundedDrain(
      [...this.#inFlight],
      this.#options.drainTimeoutMs ?? 5000,
    );
    for (const module of modules)
      try {
        await runCleanupHook(
          module,
          "dispose",
          this.#options.drainTimeoutMs ?? 5000,
        );
      } catch (error) {
        failures.push(error);
      }
    this.#values.clear();
    this.#controllers.clear();
    return failures;
  }
  private preflight(
    activations: readonly InformationModuleActivation[],
  ): PreparedModule[] {
    const catalog = defineInformationModuleCatalog(
      ...this.#options.catalog.definitions,
    );
    const definitions = new Map(
      catalog.definitions.map((d) => [d.manifest.definitionId, d]),
    );
    const kinds = catalogInformationKinds(catalog);
    for (const kind of kinds)
      if (this.#options.core.registry.get(kind.kind) !== kind)
        throw new Error(`Information kind definition mismatch: ${kind.kind}`);
    for (const field of ["selectors", "promptRenderers"] as const) {
      const seen = new Map<string, unknown>();
      for (const { manifest } of catalog.definitions)
        for (const item of manifest[field]) {
          const id = "selectorId" in item ? item.selectorId : item.rendererId;
          if (seen.has(id) && seen.get(id) !== item)
            throw new Error(`Conflicting ${field} definition: ${id}`);
          seen.set(id, item);
          if ("kinds" in item)
            for (const kind of item.kinds)
              if (!kinds.includes(kind))
                throw new Error(`Renderer kind is not declared: ${kind.kind}`);
        }
    }
    const ids = new Set<string>(),
      prepared: PreparedModule[] = [];
    for (const activation of activations) {
      assertSafeInstanceSource(activation.instanceId);
      if (ids.has(activation.instanceId))
        throw new Error(
          `Duplicate information module instance id: ${activation.instanceId}`,
        );
      ids.add(activation.instanceId);
      const definition = definitions.get(activation.definitionId);
      if (!definition)
        throw new ModuleDefinitionNotFoundError(activation.definitionId);
      if (activation.enabled === false) continue;
      const settings = deepFreeze(
        definition.manifest.settingsSchema.parse(activation.settings),
      );
      // fingerprint 也在 create 前生成，避免 inspection 在资源取得后才发现不可表示的 schema。
      schemaFingerprint(definition);
      prepared.push({
        definition,
        instanceId: activation.instanceId,
        settings,
        controller: new AbortController(),
      });
    }
    const providers = new Map<
      string,
      { capability: ModuleCapability<any>; instanceId: string }
    >();
    for (const value of this.#options.capabilities ?? []) {
      if (providers.has(value.capability.id))
        throw new Error(
          `Duplicate capability provider: ${value.capability.id}`,
        );
      providers.set(value.capability.id, {
        capability: value.capability,
        instanceId: "@host",
      });
      this.#values.set(value.capability.id, value);
    }
    for (const module of prepared)
      for (const capability of module.definition.manifest.provides) {
        if (providers.has(capability.id))
          throw new Error(`Duplicate capability provider: ${capability.id}`);
        providers.set(capability.id, {
          capability,
          instanceId: module.instanceId,
        });
      }
    for (const module of prepared) {
      const bindings = new Map<string, string>();
      for (const required of module.definition.manifest.requires) {
        const provider = providers.get(required.id);
        if (!provider) throw new Error(`Missing capability: ${required.id}`);
        if (provider.capability.apiVersion !== required.apiVersion)
          throw new Error(`Capability version mismatch: ${required.id}`);
        bindings.set(required.id, provider.instanceId);
      }
      this.#bindings.set(module.instanceId, bindings);
    }
    const sorted: PreparedModule[] = [],
      visiting = new Set<string>(),
      visited = new Set<string>();
    const visit = (module: PreparedModule) => {
      if (visited.has(module.instanceId)) return;
      if (visiting.has(module.instanceId))
        throw new Error("Module capability dependency cycle");
      visiting.add(module.instanceId);
      for (const provider of [
        ...this.#bindings.get(module.instanceId)!.values(),
      ].sort())
        if (provider !== "@host")
          visit(prepared.find((m) => m.instanceId === provider)!);
      visiting.delete(module.instanceId);
      visited.add(module.instanceId);
      sorted.push(module);
    };
    for (const module of prepared.sort((a, b) =>
      a.instanceId.localeCompare(b.instanceId),
    ))
      visit(module);
    return sorted;
  }
  private validateInstance(module: ActiveInformationModule): void {
    const { manifest } = module.definition;
    if (
      !Array.isArray(module.instance.provisions) ||
      !Array.isArray(module.instance.subscriptions)
    )
      throw new Error("Invalid module instance");
    const provided = new Set<string>();
    for (const value of module.instance.provisions) {
      const expected = manifest.provides.find(
        (c) => c.id === value.capability.id,
      );
      if (
        !expected ||
        expected.apiVersion !== value.capability.apiVersion ||
        provided.has(expected.id)
      )
        throw new Error(`Module provision mismatch: ${value.capability.id}`);
      provided.add(expected.id);
    }
    if (provided.size !== manifest.provides.length)
      throw new Error("Module provision mismatch: missing implementation");
    const ids = new Set<string>();
    for (const subscription of module.instance.subscriptions) {
      if (
        !/^[a-z][a-z0-9._:-]*$/u.test(subscription.subscriptionId) ||
        ids.has(subscription.subscriptionId)
      )
        throw new Error("Invalid or duplicate subscription id");
      ids.add(subscription.subscriptionId);
      if (
        subscription.delivery !== "live" &&
        subscription.delivery !== "durable"
      )
        throw new Error("Invalid subscription delivery");
      const declared = manifest.consumes.find(
        (k) => k.kind === subscription.kind,
      );
      if (!declared)
        throw new ModuleKindNotDeclaredError(
          manifest.definitionId,
          subscription.kind,
        );
      if (declared !== subscription.definition)
        throw new Error(
          `Information subscription definition mismatch: ${subscription.kind}`,
        );
    }
    module.subscriptions = Object.freeze(
      module.instance.subscriptions.map((subscription) =>
        Object.freeze({ ...subscription }),
      ),
    );
    module.provisions = Object.freeze(
      module.instance.provisions.map((provision) =>
        Object.freeze({
          ...provision,
          capability: Object.freeze({ ...provision.capability }),
        }),
      ),
    );
  }
  private createLifecycleContext(
    module: PreparedModule,
    signal: AbortSignal = module.controller.signal,
    sourceAtom?: DeepReadonly<InformationAtom>,
  ): InformationModuleCreateContext {
    return {
      signal,
      now: this.#options.now ?? (() => new Date()),
      use: <T>(capability: ModuleCapability<T>): T => {
        if (module.controller.signal.aborted)
          throw new Error("Module activation has stopped");
        const declared = module.definition.manifest.requires.find(
          (c) =>
            c.id === capability.id && c.apiVersion === capability.apiVersion,
        );
        if (!declared)
          throw new Error(`Capability is not declared: ${capability.id}`);
        const value = this.#values.get(capability.id);
        if (!value || value.capability.apiVersion !== capability.apiVersion)
          throw new Error(`Capability is unavailable: ${capability.id}`);
        return value.value as T;
      },
      report: (definition, payload) =>
        this.reportDiagnostic(module, definition, payload, sourceAtom),
    };
  }
  private createContext(
    module: ActiveInformationModule,
    sourceAtom: DeepReadonly<InformationAtom>,
    deliverySignal?: AbortSignal,
  ): InformationModuleHandlerContext {
    const signal = deliverySignal
      ? AbortSignal.any([module.controller.signal, deliverySignal])
      : module.controller.signal;
    const lifecycle = this.createLifecycleContext(module, signal, sourceAtom);
    const selectedContexts = new Set<string>();
    const prepare = <K extends string, P extends JsonObject>(
      definition: InformationKindDefinition<K, P>,
      input: ModuleRegistrationInput<P>,
    ) => {
      signal.throwIfAborted();
      if (
        !module.definition.manifest.produces.includes(definition) ||
        this.#options.core.registry.get(definition.kind) !== definition
      )
        throw new ModuleKindNotDeclaredError(
          module.definition.manifest.definitionId,
          definition.kind,
        );
      const custom = input.references ?? [];
      if (custom.some((reference) => isReservedRelation(reference.relation)))
        throw new Error(
          "Information module cannot override core causal references",
        );
      if (
        input.contextInformationId !== undefined &&
        !selectedContexts.has(input.contextInformationId)
      ) {
        throw new Error(
          "Module context override must reference a selected core.runtime.context",
        );
      }
      const inheritedContext =
        input.contextInformationId === undefined
          ? contextReferences(sourceAtom)
          : [
              {
                relation: "core:context",
                informationId: input.contextInformationId,
              },
            ];
      return {
        occurredAt: lifecycle.now().toISOString(),
        source: `module:${module.instanceId}`,
        payload: input.payload,
        references: [
          {
            relation: "core:caused-by",
            informationId: sourceAtom.informationId,
          },
          ...inheritedContext,
          ...custom,
        ],
      };
    };
    return {
      ...lifecycle,
      signal,
      definitionId: module.definition.manifest.definitionId,
      instanceId: module.instanceId,
      sourceAtom,
      select: async (selector) => {
        signal.throwIfAborted();
        if (!module.definition.manifest.selectors.includes(selector))
          throw new Error(`Selector is not declared: ${selector.selectorId}`);
        const selected = await this.#options.core.select(
          selector,
          sourceAtom.informationId,
        );
        for (const atom of selected) {
          if (atom.kind === "core.runtime.context")
            selectedContexts.add(atom.informationId);
        }
        return selected;
      },
      register: async (definition, input) =>
        this.#options.core.register(definition, prepare(definition, input)),
      registerOnce: async (operation, key, definition, input) =>
        this.#options.core.registerOnce(
          operation,
          key,
          definition,
          prepare(definition, input),
        ),
      commitTerminal: async (group, subject, definition, input) =>
        this.#options.core.commitTerminal(
          group,
          subject,
          definition,
          prepare(definition, input),
        ),
    };
  }

  inspect() {
    return this.#options.catalog.definitions
      .map(({ manifest }) => ({
        definitionId: manifest.definitionId,
        displayName: manifest.displayName,
        description: manifest.description,
        moduleVersion: manifest.moduleVersion,
        protocolVersion: manifest.protocolVersion,
        settingsSchemaFingerprint: schemaFingerprint({
          manifest,
        } as InformationModuleDefinition),
        consumes: manifest.consumes
          .map(({ kind, displayName, description }) => ({
            kind,
            displayName,
            description,
          }))
          .sort((a, b) => a.kind.localeCompare(b.kind)),
        produces: manifest.produces
          .map(({ kind, displayName, description }) => ({
            kind,
            displayName,
            description,
          }))
          .sort((a, b) => a.kind.localeCompare(b.kind)),
        selectors: manifest.selectors.map((s) => s.selectorId).sort(),
        promptRenderers: manifest.promptRenderers
          .map(({ rendererId, displayName, description, kinds }) => ({
            rendererId,
            displayName,
            description,
            kinds: kinds.map(({ kind }) => kind).sort(),
          }))
          .sort((a, b) => a.rendererId.localeCompare(b.rendererId)),
        diagnostics: (manifest.diagnostics ?? [])
          .map((diagnostic) => diagnostic.event)
          .sort(),
        requires: manifest.requires.map((c) => ({
          id: c.id,
          apiVersion: c.apiVersion,
        })),
        provides: manifest.provides.map((c) => ({
          id: c.id,
          apiVersion: c.apiVersion,
        })),
        bindings: this.#active
          .filter(
            (m) => m.definition.manifest.definitionId === manifest.definitionId,
          )
          .map((m) => ({
            instanceId: m.instanceId,
            capabilities: [...this.#bindings.get(m.instanceId)!].map(
              ([capabilityId, provider]) => ({ capabilityId, provider }),
            ),
          })),
      }))
      .sort((a, b) => a.definitionId.localeCompare(b.definitionId));
  }
  private async reportDiagnostic<E extends string, P extends JsonObject>(
    module: PreparedModule,
    definition: ModuleDiagnosticDefinition<E, P>,
    payload: P,
    sourceAtom?: DeepReadonly<InformationAtom>,
  ): Promise<void> {
    const declared = (module.definition.manifest.diagnostics ?? []).includes(
      definition as ModuleDiagnosticDefinition<string, any>,
    );
    if (!declared) {
      await this.rejectDiagnostic(module, "undeclared_definition");
      return;
    }
    const parsed = definition.payloadSchema.safeParse(payload);
    if (!parsed.success) {
      await this.rejectDiagnostic(module, "invalid_payload");
      return;
    }
    let frozen: DeepReadonly<P>;
    try {
      frozen = deepFreeze(parsed.data) as DeepReadonly<P>;
    } catch {
      await this.rejectDiagnostic(module, "invalid_payload");
      return;
    }
    const contextInformationId = sourceAtom?.references
      .filter(({ relation }) => relation === "core:context")
      .map(({ informationId }) => informationId)[0];
    try {
      await this.#options.observer?.({
        category: "diagnostic",
        event: definition.event,
        level: definition.level,
        message: definition.message,
        definitionId: module.definition.manifest.definitionId,
        instanceId: module.instanceId,
        ...(sourceAtom === undefined
          ? {}
          : { sourceInformationId: sourceAtom.informationId }),
        ...(contextInformationId === undefined ? {} : { contextInformationId }),
        diagnostic: {
          definition: definition as unknown as ModuleDiagnosticDefinition<
            string,
            JsonObject
          >,
          payload: frozen as DeepReadonly<JsonObject>,
        },
      });
    } catch {
      await this.rejectDiagnostic(module, "observer_failed");
    }
  }
  private async rejectDiagnostic(
    module: PreparedModule,
    reason: "undeclared_definition" | "invalid_payload" | "observer_failed",
  ): Promise<void> {
    try {
      await this.#options.observer?.({
        category: "diagnostic-rejected",
        event: "module.diagnostic.rejected",
        level: "warn",
        message: "Module diagnostic rejected",
        definitionId: module.definition.manifest.definitionId,
        instanceId: module.instanceId,
        fields: { reason },
      });
    } catch {
      // 诊断及其失败汇报都不得改变模块生命周期或业务处理结果。
    }
  }
  private async observe(observation: ModuleHostObservation): Promise<void> {
    try {
      await this.#options.observer?.(observation);
    } catch {
      // Host 生命周期是权威事实；可观测性故障不改变模块状态。
    }
  }
  private assertStarting(): void {
    if (this.#state !== "starting")
      throw new Error("ModuleHost startup was cancelled");
  }
  private trackHandler(
    handler: () => unknown | Promise<unknown>,
  ): Promise<unknown> {
    const operation = Promise.resolve().then(handler);
    this.#inFlight.add(operation);
    void operation.then(
      () => this.#inFlight.delete(operation),
      () => this.#inFlight.delete(operation),
    );
    return operation;
  }
}
function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value && typeof value === "object") {
    if (
      seen.has(value) ||
      (!Array.isArray(value) &&
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null)
    )
      throw new Error("Module settings must be acyclic JSON data");
    seen.add(value);
    for (const child of Object.values(value)) deepFreeze(child, seen);
    seen.delete(value);
    Object.freeze(value);
  } else if (
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint" ||
    (typeof value === "number" && !Number.isFinite(value))
  )
    throw new Error("Module settings must be JSON data");
  return value;
}
function schemaFingerprint(definition: InformationModuleDefinition): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        z.toJSONSchema(definition.manifest.settingsSchema, {
          unrepresentable: "any",
        }),
      ),
    )
    .digest("hex");
}
async function boundedDrain(
  pending: readonly Promise<unknown>[],
  timeout: number,
): Promise<void> {
  if (!pending.length) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeout);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
/** 清理超时保留可诊断的实例/阶段信息，不包含设置值或 hook 异常正文。 */
class ModuleLifecycleTimeoutError extends Error {
  constructor(
    readonly instanceId: string,
    readonly hook: "stop" | "dispose",
    readonly timeoutMs: number,
  ) {
    super(
      `Information module ${hook} timed out: ${instanceId} (${timeoutMs}ms)`,
    );
    this.name = "ModuleLifecycleTimeoutError";
  }
}
async function runCleanupHook(
  module: ActiveInformationModule,
  hook: "stop" | "dispose",
  timeoutMs: number,
): Promise<void> {
  if (!module.instance[hook]) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // race 持续消费原 hook Promise，因此超时后的 reject 不会成为未处理拒绝。
  const operation = Promise.resolve().then(() => module.instance[hook]?.());
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ModuleLifecycleTimeoutError(
                module.instanceId,
                hook,
                timeoutMs,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
function contextReferences(
  atom: DeepReadonly<InformationAtom>,
): InformationReference[] {
  const references = atom.references.filter(
    (reference) => reference.relation === "core:context",
  );
  if (references.length > 0)
    return references.map((reference) => ({ ...reference }));
  if (atom.kind === "core.runtime.context") {
    return [{ relation: "core:context", informationId: atom.informationId }];
  }
  return [];
}

function isReservedRelation(relation: string): boolean {
  return relation === "core:caused-by" || relation === "core:context";
}

function moduleLifecycleObservation(
  event: string,
  level: "debug" | "info" | "warn" | "error",
  message: string,
  module: PreparedModule,
  fields: JsonObject,
): ModuleHostObservation {
  return {
    category: "lifecycle",
    event,
    level,
    message,
    definitionId: module.definition.manifest.definitionId,
    instanceId: module.instanceId,
    fields,
  };
}

function validateStartupDescription(value: unknown): ModuleStartupDescription {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error("Invalid module startup description");
  const description = value as { summary?: unknown; fields?: unknown };
  if (
    typeof description.summary !== "string" ||
    !description.summary.trim() ||
    description.summary.includes("\n") ||
    Array.from(description.summary).length > 512
  )
    throw new Error("Invalid module startup summary");
  if (
    description.fields !== undefined &&
    (typeof description.fields !== "object" ||
      description.fields === null ||
      Array.isArray(description.fields))
  )
    throw new Error("Invalid module startup fields");
  const fields =
    description.fields === undefined
      ? undefined
      : cloneStartupFields(description.fields);
  return Object.freeze({
    summary: description.summary.trim(),
    ...(fields === undefined ? {} : { fields }),
  });
}

function safeErrorType(error: unknown): string {
  if (!(error instanceof Error)) return "NonError";
  return /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(error.name)
    ? error.name
    : "Error";
}

const FORBIDDEN_STARTUP_FIELD_KEYS = new Set([
  "content",
  "credentials",
  "headers",
  "password",
  "prompt",
  "raw",
  "response",
  "secret",
  "settings",
  "target",
  "text",
  "token",
]);

function cloneStartupFields(value: unknown): JsonObject {
  const clone = cloneStartupObject(value);
  if (clone === undefined) throw new Error("Invalid module startup fields");
  return deepFreeze(clone);
}

function cloneStartupObject(value: unknown): JsonObject | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return undefined;
  const clone: JsonObject = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || FORBIDDEN_STARTUP_FIELD_KEYS.has(key))
      return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    )
      return undefined;
    const child = cloneStartupValue(descriptor.value);
    if (child === undefined) return undefined;
    clone[key] = child;
  }
  return clone;
}

function cloneStartupValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const clone: JsonValue[] = [];
    for (const item of value) {
      const child = cloneStartupValue(item);
      if (child === undefined) return undefined;
      clone.push(child);
    }
    return clone;
  }
  return cloneStartupObject(value);
}

function assertSafeInstanceSource(instanceId: string): void {
  if (!/^[a-z][a-z0-9._-]*$/u.test(instanceId)) {
    throw new Error("Information module instance id must form a safe source");
  }
}
