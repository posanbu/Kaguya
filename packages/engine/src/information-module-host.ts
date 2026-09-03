/**
 * 功能概述：本模块把 SDK 定义的信息模块实例接入 `InformationCore`，并为每个订阅
 * 赋予稳定的模块消费者身份和可注册派生 atom 的 handler context。
 * 主要职责：`InformationModuleHost.register/start/stop` 管理模块生命周期；启动时
 * 先验证每个 subscription 的 definition 与 manifest 同一对象，再调用 Core.on；
 * `createContext` 只允许 manifest 声明的输出，
 * 为 Core.register 补齐模块 source、因果关系与唯一继承的 context 引用。
 * 代码库关系：依赖 SDK 的 information-module 契约和 Core 的最终 on/register API；
 * Core 负责广播并记录 consumer.failed，因此本宿主不吞掉或二次记录 handler 故障。
 * 输入输出与副作用：启动和停止会增删 Core 订阅并调用模块 dispose；context.register
 * 会持久化新 atom，且拒绝调用方覆盖 core:caused-by 或 core:context 保留关系。
 */
import type {
  DeepReadonly,
  InformationAtom,
  InformationReference,
} from "@kaguya/schema";
import type {
  InformationKindDefinition,
} from "@kaguya/sdk";
import {
  type InformationModuleActivation,
  type InformationModuleDefinition,
  type InformationModuleHandlerContext,
  type InformationModuleInstance,
} from "@kaguya/sdk";

import { InformationCore } from "./information-core.js";

export interface InformationModuleHostOptions {
  readonly core: InformationCore;
  readonly now?: () => Date;
}

export class InformationModuleDefinitionNotFoundError extends Error {
  constructor(readonly definitionId: string) {
    super(`Information module definition is not registered: ${definitionId}`);
    this.name = "InformationModuleDefinitionNotFoundError";
  }
}

export class InformationModuleKindNotDeclaredError extends Error {
  constructor(
    readonly definitionId: string,
    readonly kind: string,
  ) {
    super(`Information module kind is not declared: ${definitionId} -> ${kind}`);
    this.name = "InformationModuleKindNotDeclaredError";
  }
}

export class InformationModuleHost {
  readonly #options: InformationModuleHostOptions;
  readonly #definitions = new Map<string, InformationModuleDefinition>();
  readonly #active = new Map<string, ActiveInformationModule>();
  readonly #unsubscribe: Array<() => void> = [];
  #state: "new" | "started" | "stopped" = "new";

  constructor(options: InformationModuleHostOptions) {
    this.#options = options;
  }

  register(definition: InformationModuleDefinition): void {
    if (this.#state !== "new") {
      throw new Error("Information module definitions can only be registered before start");
    }
    const definitionId = definition.manifest.definitionId;
    if (this.#definitions.has(definitionId)) {
      throw new Error(`Duplicate information module definition id: ${definitionId}`);
    }
    this.#definitions.set(definitionId, definition);
  }

  async start(activations: readonly InformationModuleActivation[]): Promise<void> {
    if (this.#state !== "new") {
      throw new Error("InformationModuleHost can only be started once");
    }

    const parsed = this.validateActivations(activations);
    const created: ActiveInformationModule[] = [];
    try {
      for (const activation of parsed) {
        const instance = await activation.definition.create({
          instanceId: activation.instanceId,
          settings: activation.settings,
        });
        this.validateSubscriptions(activation.definition, instance);
        created.push({
          definition: activation.definition,
          instanceId: activation.instanceId,
          instance,
        });
      }

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
              (atom) => subscription.handle(atom, this.createContext(module, atom)),
            ),
          );
        }
      }
      for (const active of created) this.#active.set(active.instanceId, active);
      this.#state = "started";
    } catch (error) {
      for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
      this.#active.clear();
      await disposeModules(created);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#state === "stopped") return;
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    const active = [...this.#active.values()];
    this.#active.clear();
    this.#state = "stopped";
    const failures = await disposeModules(active);
    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more information modules failed to stop");
    }
  }

  private validateActivations(activations: readonly InformationModuleActivation[]): Array<{
    readonly definition: InformationModuleDefinition;
    readonly instanceId: string;
    readonly settings: unknown;
  }> {
    const ids = new Set<string>();
    return activations.map((activation) => {
      const instanceId = activation.instanceId.trim();
      if (!instanceId) throw new Error("Information module instance id must not be empty");
      if (ids.has(instanceId)) throw new Error(`Duplicate information module instance id: ${instanceId}`);
      ids.add(instanceId);
      const definition = this.#definitions.get(activation.definitionId);
      if (definition === undefined) {
        throw new InformationModuleDefinitionNotFoundError(activation.definitionId);
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
    const declared = new Set(definition.manifest.informationKinds.map((kind) => kind.kind));
    for (const subscription of instance.subscriptions) {
      if (!declared.has(subscription.kind)) {
        throw new InformationModuleKindNotDeclaredError(
          definition.manifest.definitionId,
          subscription.kind,
        );
      }
      const registered = this.#options.core.registry.get(subscription.kind);
      const declaredDefinition = definition.manifest.informationKinds.find(
        (kind) => kind.kind === subscription.kind,
      );
      if (subscription.definition !== declaredDefinition) {
        throw new Error(`Information subscription definition mismatch: ${subscription.kind}`);
      }
      if (registered !== declaredDefinition) {
        throw new Error(`Information kind definition mismatch: ${subscription.kind}`);
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
          throw new InformationModuleKindNotDeclaredError(
            module.definition.manifest.definitionId,
            definition.kind,
          );
        }
        const customReferences = input.references ?? [];
        if (customReferences.some((reference) => isReservedRelation(reference.relation))) {
          throw new Error("Information module cannot override core causal references");
        }
        const references = [
          { relation: "core:caused-by", informationId: sourceAtom.informationId },
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
    const declared = module.manifest.informationKinds.find((kind) => kind.kind === definition.kind);
    return declared === definition && this.#options.core.registry.get(definition.kind) === definition;
  }
}

interface ActiveInformationModule {
  readonly definition: InformationModuleDefinition;
  readonly instanceId: string;
  readonly instance: InformationModuleInstance;
}

function contextReferences(atom: DeepReadonly<InformationAtom>): InformationReference[] {
  const references = atom.references.filter((reference) => reference.relation === "core:context");
  if (references.length > 0) return references.map((reference) => ({ ...reference }));
  if (atom.kind === "core.runtime.context") {
    return [{ relation: "core:context", informationId: atom.informationId }];
  }
  return [];
}

function isReservedRelation(relation: string): boolean {
  return relation === "core:caused-by" || relation === "core:context";
}

async function disposeModules(modules: readonly ActiveInformationModule[]): Promise<unknown[]> {
  const results = await Promise.allSettled(
    modules.map(({ instance }) => Promise.resolve(instance.dispose?.())),
  );
  return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
}
