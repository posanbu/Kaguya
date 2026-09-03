import type {
  DeepReadonly,
  InformationAtom,
  InformationReference,
  JsonObject,
} from "@kaguya/schema";
import type {
  InformationAppendInput,
  InformationKindDefinition,
} from "@kaguya/sdk";
import {
  type InformationModuleActivation,
  type InformationModuleDefinition,
  type InformationModuleHandlerContext,
  type InformationModuleInstance,
  type InformationModuleRunLifecycle,
  type InformationModuleRunLifecycleInput,
  type InformationModuleSubscription,
} from "@kaguya/sdk";

import { InformationCore } from "./information-core.js";

export interface InformationModuleHostOptions {
  readonly core: InformationCore;
  readonly now?: () => Date;
  readonly runLifecycle?: InformationModuleRunLifecycle;
  readonly onHandlerError?: (error: unknown) => void | Promise<void>;
}

export class InformationModuleDefinitionNotFoundError extends Error {
  constructor(readonly definitionId: string) {
    super(`Information module definition is not registered: ${definitionId}`);
    this.name = "InformationModuleDefinitionNotFoundError";
  }
}

export class InformationModuleTargetNotFoundError extends Error {
  constructor(
    readonly kind: string,
    readonly targetInstanceId: string,
  ) {
    super(`No active information module handles ${kind}: ${targetInstanceId}`);
    this.name = "InformationModuleTargetNotFoundError";
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

      const grouped = groupSubscriptions(created);
      for (const [kind, subscriptions] of grouped) {
        assertCompatibleSubscriptions(kind, subscriptions);
        this.#unsubscribe.push(
          this.#options.core.subscribe(kind, async (atom) => {
            await this.handleAtom(atom, subscriptions);
          }),
        );
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
      if (registered !== declaredDefinition) {
        throw new Error(`Information kind definition mismatch: ${subscription.kind}`);
      }
    }
  }

  private async handleAtom(
    atom: DeepReadonly<InformationAtom>,
    subscriptions: readonly ActiveInformationSubscription[],
  ): Promise<void> {
    let matching = subscriptions;
    if (subscriptions[0]?.subscription.targeted === true) {
      const targetInstanceId = targetOf(atom);
      matching = subscriptions.filter(({ module }) => module.instanceId === targetInstanceId);
      if (matching.length === 0) {
        throw new InformationModuleTargetNotFoundError(atom.kind, targetInstanceId);
      }
    }

    await Promise.allSettled(
      matching.map(async ({ module, subscription }) => {
        const lifecycleInput = {
          definitionId: module.definition.manifest.definitionId,
          instanceId: module.instanceId,
          sourceAtom: atom,
        };
        await invokeLifecycle(this.#options.runLifecycle, "started", lifecycleInput);
        try {
          await subscription.handle(atom, this.createContext(module, atom));
          await invokeLifecycle(this.#options.runLifecycle, "completed", lifecycleInput);
        } catch (error) {
          if (isCancelled(error)) {
            await invokeLifecycle(this.#options.runLifecycle, "cancelled", {
              ...lifecycleInput,
              error,
            });
          } else {
            await invokeLifecycle(this.#options.runLifecycle, "failed", {
              ...lifecycleInput,
              error,
            });
          }
          await reportError(this.#options.onHandlerError, error);
        }
      }),
    );
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
      append: async (definition, input) => {
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
        return this.#options.core.append(definition, {
          ...(input as Omit<InformationAppendInput<any, any>, "occurredAt" | "source" | "references">),
          kind: definition.kind,
          occurredAt: now().toISOString(),
          source: `module:${module.instanceId}`,
          references,
        } as InformationAppendInput<any, any>);
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

interface ActiveInformationSubscription {
  readonly module: ActiveInformationModule;
  readonly subscription: InformationModuleSubscription;
}

function groupSubscriptions(
  modules: readonly ActiveInformationModule[],
): Map<string, ActiveInformationSubscription[]> {
  const grouped = new Map<string, ActiveInformationSubscription[]>();
  for (const module of modules) {
    for (const subscription of module.instance.subscriptions) {
      const current = grouped.get(subscription.kind) ?? [];
      current.push({ module, subscription });
      grouped.set(subscription.kind, current);
    }
  }
  return grouped;
}

function assertCompatibleSubscriptions(
  kind: string,
  subscriptions: readonly ActiveInformationSubscription[],
): void {
  const first = subscriptions[0];
  if (first === undefined) return;
  for (const current of subscriptions.slice(1)) {
    if (current.subscription.targeted !== first.subscription.targeted) {
      throw new Error(`Information kind cannot mix targeted and broadcast subscriptions: ${kind}`);
    }
  }
}

function targetOf(atom: DeepReadonly<InformationAtom>): string {
  const payload = atom.payload as Record<string, unknown>;
  if (typeof payload.targetInstanceId !== "string" || payload.targetInstanceId.trim().length === 0) {
    throw new TypeError(`Targeted information ${atom.kind} requires targetInstanceId`);
  }
  return payload.targetInstanceId;
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

function isCancelled(error: unknown): boolean {
  return (
    (typeof error === "object" && error !== null && "kind" in error && error.kind === "cancelled") ||
    (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError")
  );
}

async function invokeLifecycle(
  lifecycle: InformationModuleRunLifecycle | undefined,
  phase: "started" | "completed" | "failed" | "cancelled",
  input: InformationModuleRunLifecycleInput & { readonly error?: unknown },
): Promise<void> {
  try {
    if (lifecycle === undefined) return;
    if (phase === "started") await lifecycle.started(input);
    if (phase === "completed") await lifecycle.completed(input);
    if (phase === "failed") await lifecycle.failed(input as InformationModuleRunLifecycleInput & { readonly error: unknown });
    if (phase === "cancelled") await lifecycle.cancelled(input);
  } catch {
    // Lifecycle bookkeeping must not alter the business handler result.
  }
}

async function reportError(
  reporter: ((error: unknown) => void | Promise<void>) | undefined,
  error: unknown,
): Promise<void> {
  try {
    await reporter?.(error);
  } catch {
    // Error reporting is best effort.
  }
}

async function disposeModules(modules: readonly ActiveInformationModule[]): Promise<unknown[]> {
  const results = await Promise.allSettled(
    modules.map(({ instance }) => Promise.resolve(instance.dispose?.())),
  );
  return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
}
