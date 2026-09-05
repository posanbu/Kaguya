/**
 * 功能概述：本模块把 SDK 定义的信息模块实例接入 `InformationCore`，并为每个订阅
 * 赋予稳定的模块消费者身份和可注册派生 atom 的 handler context。
 * 主要职责：`ModuleHost.register/start/stop` 以共享 promise 管理并发生命周期；启动时
 * 先验证每个 subscription 的 definition 与 manifest 同一对象，再调用 Core.on；
 * `createContext` 只允许 manifest 声明的输出，
 * 为 Core.register 补齐模块 source、因果关系与唯一继承的 context 引用。
 * 代码库关系：依赖 SDK 的 information-module 契约和 Core 的最终 on/register API；
 * Core 负责广播并记录 consumer.failed，因此本宿主不吞掉或二次记录 handler 故障。
 * 输入输出与副作用：启动验证 instanceId 能组成小写安全 source；停止先撤销订阅、等待
 * 已进入的 handler，再以 all-settled 方式调用全部模块 dispose；启动 rollback 的释放失败
 * 同时反馈给 start 与并发 stop。启动/停止竞态不会重复创建、重复释放或复活宿主；
 * context.register 会持久化新 atom，且拒绝调用方覆盖 Core 保留关系。
 */
import type {
  DeepReadonly,
  InformationAtom,
  InformationReference,
} from "@kaguya/schema";
import type { InformationKindDefinition } from "@kaguya/sdk";
import {
  type InformationModuleActivation,
  type InformationModuleDefinition,
  type InformationModuleHandlerContext,
  type InformationModuleInstance,
} from "@kaguya/sdk";

import { InformationCore } from "./information-core.js";

export interface ModuleHostOptions {
  readonly core: InformationCore;
  readonly now?: () => Date;
}

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

export class ModuleHost {
  readonly #options: ModuleHostOptions;
  readonly #definitions = new Map<string, InformationModuleDefinition>();
  readonly #active = new Map<string, ActiveInformationModule>();
  readonly #unsubscribe: Array<() => void> = [];
  readonly #inFlight = new Set<Promise<unknown>>();
  #state: "new" | "starting" | "started" | "stopping" | "stopped" = "new";
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  readonly #startupRollbackFailures: unknown[] = [];

  constructor(options: ModuleHostOptions) {
    this.#options = options;
  }

  register(definition: InformationModuleDefinition): void {
    if (this.#state !== "new") {
      throw new Error(
        "Information module definitions can only be registered before start",
      );
    }
    const definitionId = definition.manifest.definitionId;
    if (this.#definitions.has(definitionId)) {
      throw new Error(
        `Duplicate information module definition id: ${definitionId}`,
      );
    }
    this.#definitions.set(definitionId, definition);
  }

  start(activations: readonly InformationModuleActivation[]): Promise<void> {
    if (this.#state === "starting") {
      return this.#startPromise!;
    }
    if (this.#state === "started") return Promise.resolve();
    if (this.#state !== "new") {
      return Promise.reject(new Error("ModuleHost cannot be restarted"));
    }
    this.#state = "starting";
    this.#startPromise = this.startHost(activations);
    return this.#startPromise;
  }

  private async startHost(
    activations: readonly InformationModuleActivation[],
  ): Promise<void> {
    const created: ActiveInformationModule[] = [];
    try {
      const parsed = this.validateActivations(activations);
      for (const activation of parsed) {
        assertSafeInstanceSource(activation.instanceId);
        const instance = await activation.definition.create({
          instanceId: activation.instanceId,
          settings: activation.settings,
        });
        const active = {
          definition: activation.definition,
          instanceId: activation.instanceId,
          instance,
        };
        // create 已取得资源后，任何本地校验失败都必须纳入回滚集合。
        created.push(active);
        this.assertStarting();
        this.validateSubscriptions(activation.definition, instance);
      }

      this.assertStarting();
      for (const module of created) {
        for (const subscription of module.instance.subscriptions) {
          this.#unsubscribe.push(
            this.#options.core.on(
              subscription.definition,
              {
                consumerId: `module:${module.instanceId}`,
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
      for (const active of created) this.#active.set(active.instanceId, active);
      this.#state = "started";
    } catch (error) {
      for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
      this.#active.clear();
      const rollbackFailures = await disposeModules(created);
      this.#startupRollbackFailures.push(...rollbackFailures);
      if (this.#state === "starting") {
        this.#state = "stopped";
      }
      if (rollbackFailures.length > 0) {
        throw new AggregateError(
          [error, ...rollbackFailures],
          "Information module startup failed during rollback",
        );
      }
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    if (this.#state === "stopped") return Promise.resolve();
    const starting =
      this.#state === "starting" ? this.#startPromise : undefined;
    this.#state = "stopping";
    this.#stopPromise = (async () => {
      await starting?.catch(() => undefined);
      for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
      await Promise.allSettled([...this.#inFlight]);
      const active = [...this.#active.values()];
      this.#active.clear();
      const rollbackFailures = this.#startupRollbackFailures.splice(0);
      const failures = [...rollbackFailures, ...(await disposeModules(active))];
      this.#state = "stopped";
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          rollbackFailures.length > 0
            ? "Information module startup rollback failed"
            : "One or more information modules failed to stop",
        );
      }
    })();
    return this.#stopPromise;
  }

  private assertStarting(): void {
    if (this.#state !== "starting") {
      throw new Error("ModuleHost startup was cancelled");
    }
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

  private validateActivations(
    activations: readonly InformationModuleActivation[],
  ): Array<{
    readonly definition: InformationModuleDefinition;
    readonly instanceId: string;
    readonly settings: unknown;
  }> {
    const ids = new Set<string>();
    return activations.map((activation) => {
      const instanceId = activation.instanceId.trim();
      if (!instanceId)
        throw new Error("Information module instance id must not be empty");
      if (ids.has(instanceId))
        throw new Error(
          `Duplicate information module instance id: ${instanceId}`,
        );
      ids.add(instanceId);
      const definition = this.#definitions.get(activation.definitionId);
      if (definition === undefined) {
        throw new ModuleDefinitionNotFoundError(activation.definitionId);
      }
      return {
        definition,
        instanceId,
        settings: definition.manifest.settingsSchema.parse(activation.settings),
      };
    });
  }

  private validateSubscriptions(
    definition: InformationModuleDefinition,
    instance: InformationModuleInstance,
  ): void {
    const declared = new Set(
      definition.manifest.informationKinds.map((kind) => kind.kind),
    );
    for (const subscription of instance.subscriptions) {
      if (!declared.has(subscription.kind)) {
        throw new ModuleKindNotDeclaredError(
          definition.manifest.definitionId,
          subscription.kind,
        );
      }
      const registered = this.#options.core.registry.get(subscription.kind);
      const declaredDefinition = definition.manifest.informationKinds.find(
        (kind) => kind.kind === subscription.kind,
      );
      if (subscription.definition !== declaredDefinition) {
        throw new Error(
          `Information subscription definition mismatch: ${subscription.kind}`,
        );
      }
      if (registered !== declaredDefinition) {
        throw new Error(
          `Information kind definition mismatch: ${subscription.kind}`,
        );
      }
    }
  }

  private createContext(
    module: ActiveInformationModule,
    sourceAtom: DeepReadonly<InformationAtom>,
  ): InformationModuleHandlerContext {
    const now = this.#options.now ?? (() => new Date());
    return {
      definitionId: module.definition.manifest.definitionId,
      instanceId: module.instanceId,
      sourceAtom,
      now,
      register: async (definition, input) => {
        if (!this.isDeclaredOutput(module.definition, definition)) {
          throw new ModuleKindNotDeclaredError(
            module.definition.manifest.definitionId,
            definition.kind,
          );
        }
        const customReferences = input.references ?? [];
        if (
          customReferences.some((reference) =>
            isReservedRelation(reference.relation),
          )
        ) {
          throw new Error(
            "Information module cannot override core causal references",
          );
        }
        const references = [
          {
            relation: "core:caused-by",
            informationId: sourceAtom.informationId,
          },
          ...contextReferences(sourceAtom),
          ...customReferences,
        ];
        return this.#options.core.register(definition, {
          occurredAt: now().toISOString(),
          source: `module:${module.instanceId}`,
          payload: input.payload,
          references,
        });
      },
    };
  }

  private isDeclaredOutput(
    module: InformationModuleDefinition,
    definition: InformationKindDefinition<string, any>,
  ): boolean {
    const declared = module.manifest.informationKinds.find(
      (kind) => kind.kind === definition.kind,
    );
    return (
      declared === definition &&
      this.#options.core.registry.get(definition.kind) === definition
    );
  }
}

interface ActiveInformationModule {
  readonly definition: InformationModuleDefinition;
  readonly instanceId: string;
  readonly instance: InformationModuleInstance;
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

function assertSafeInstanceSource(instanceId: string): void {
  if (!/^[a-z][a-z0-9._-]*$/u.test(instanceId)) {
    throw new Error("Information module instance id must form a safe source");
  }
}

async function disposeModules(
  modules: readonly ActiveInformationModule[],
): Promise<unknown[]> {
  const results = await Promise.allSettled(
    modules.map(({ instance }) =>
      Promise.resolve().then(() => instance.dispose?.()),
    ),
  );
  return results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
}
