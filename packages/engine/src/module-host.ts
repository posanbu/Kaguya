import type { EventEnvelope } from "@kaguya/schema";
import type {
  EventDefinition,
  ModuleActivation,
  ModuleDefinition,
  ModuleHandlerContext,
  ModuleInstance,
  ModuleSubscription,
} from "@kaguya/sdk";

import { EventBus } from "./event-bus.js";

export interface ModuleHostOptions {
  readonly eventBus: EventBus;
  readonly now: () => Date;
  readonly nextId: (traceId: string, prefix: string) => string;
}

interface ActiveModule {
  readonly definition: ModuleDefinition;
  readonly instanceId: string;
  readonly instance: ModuleInstance;
}

interface ActiveSubscription {
  readonly module: ActiveModule;
  readonly subscription: ModuleSubscription;
}

export class ModuleDefinitionNotFoundError extends Error {
  constructor(readonly definitionId: string) {
    super(`Module definition is not registered: ${definitionId}`);
    this.name = "ModuleDefinitionNotFoundError";
  }
}

export class ModuleTargetNotFoundError extends Error {
  constructor(
    readonly eventType: string,
    readonly targetInstanceId: string,
  ) {
    super(
      `No active module instance handles ${eventType}: ${targetInstanceId}`,
    );
    this.name = "ModuleTargetNotFoundError";
  }
}

export class ModuleHost {
  private readonly definitions = new Map<string, ModuleDefinition>();
  private readonly activeModules = new Map<string, ActiveModule>();
  private readonly unsubscribe: Array<() => void> = [];
  private state: "new" | "started" | "stopped" = "new";

  constructor(private readonly options: ModuleHostOptions) {}

  register(definition: ModuleDefinition): void {
    if (this.state !== "new") {
      throw new Error("Module definitions can only be registered before start");
    }
    const definitionId = definition.manifest.definitionId;
    if (this.definitions.has(definitionId)) {
      throw new Error(`Duplicate module definition id: ${definitionId}`);
    }
    this.definitions.set(definitionId, definition);
  }

  async start(activations: readonly ModuleActivation[]): Promise<void> {
    if (this.state !== "new") {
      throw new Error("ModuleHost can only be started once");
    }

    const parsedActivations = this.validateActivations(activations);
    const created: ActiveModule[] = [];
    try {
      for (const activation of parsedActivations) {
        const instance = await activation.definition.create({
          instanceId: activation.instanceId,
          settings: activation.settings,
        });
        created.push({
          definition: activation.definition,
          instanceId: activation.instanceId,
          instance,
        });
      }
      const grouped = groupSubscriptions(created);
      for (const [eventType, subscriptions] of grouped) {
        assertCompatibleSubscriptions(eventType, subscriptions);
      }
      for (const active of created) {
        this.activeModules.set(active.instanceId, active);
      }
      for (const [eventType, subscriptions] of grouped) {
        this.unsubscribe.push(
          this.options.eventBus.subscribe(eventType, async (event) => {
            await this.handleEvent(event, subscriptions);
            return { continue: true, event };
          }),
        );
      }
      this.state = "started";
    } catch (error) {
      for (const unsubscribe of this.unsubscribe.splice(0)) {
        unsubscribe();
      }
      this.activeModules.clear();
      await disposeModules(created);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.state === "stopped") {
      return;
    }
    for (const unsubscribe of this.unsubscribe.splice(0)) {
      unsubscribe();
    }
    const active = [...this.activeModules.values()];
    this.activeModules.clear();
    this.state = "stopped";
    const failures = await disposeModules(active);
    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more modules failed to stop");
    }
  }

  private validateActivations(activations: readonly ModuleActivation[]): Array<{
    readonly definition: ModuleDefinition;
    readonly instanceId: string;
    readonly settings: unknown;
  }> {
    const instanceIds = new Set<string>();
    return activations.map((activation) => {
      const instanceId = activation.instanceId.trim();
      if (!instanceId) {
        throw new Error("Module instance id must not be empty");
      }
      if (instanceIds.has(instanceId)) {
        throw new Error(`Duplicate module instance id: ${instanceId}`);
      }
      instanceIds.add(instanceId);
      const definition = this.definitions.get(activation.definitionId);
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

  private async handleEvent(
    event: EventEnvelope,
    subscriptions: readonly ActiveSubscription[],
  ): Promise<void> {
    const targeted = subscriptions[0]?.subscription.targeted === true;
    let matching = subscriptions;
    if (targeted) {
      const targetInstanceId = targetOf(event);
      matching = subscriptions.filter(
        ({ module }) => module.instanceId === targetInstanceId,
      );
      if (matching.length === 0) {
        throw new ModuleTargetNotFoundError(event.type, targetInstanceId);
      }
    }

    const results = await Promise.allSettled(
      matching.map(async ({ module, subscription }) => {
        const parsedEvent = parseSubscribedEvent(subscription.event, event);
        await subscription.handle(
          parsedEvent,
          this.createHandlerContext(module, parsedEvent),
        );
      }),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `One or more modules failed while handling ${event.type}`,
      );
    }
  }

  private createHandlerContext(
    module: ActiveModule,
    sourceEvent: EventEnvelope,
  ): ModuleHandlerContext {
    return {
      definitionId: module.definition.manifest.definitionId,
      instanceId: module.instanceId,
      traceId: sourceEvent.traceId,
      ...(sourceEvent.sessionId === undefined
        ? {}
        : { sessionId: sourceEvent.sessionId }),
      sourceEvent,
      now: this.options.now,
      nextId: (prefix) => this.options.nextId(sourceEvent.traceId, prefix),
      emit: async (definition, payload, metadata = {}) => {
        this.assertTarget(definition.type, payload);
        const derived = definition.create(
          {
            id: this.options.nextId(sourceEvent.traceId, "event"),
            source: `module:${module.instanceId}`,
            occurredAt: this.options.now().toISOString(),
            traceId: sourceEvent.traceId,
            ...(sourceEvent.sessionId === undefined
              ? {}
              : { sessionId: sourceEvent.sessionId }),
            metadata: {
              ...metadata,
              causationEventId: sourceEvent.id,
              moduleDefinitionId: module.definition.manifest.definitionId,
              moduleInstanceId: module.instanceId,
            },
          },
          payload,
        );
        const result = await this.options.eventBus.emit(derived, {
          validate: (candidate) => {
            validateDerivedEvent(definition, derived, candidate);
          },
        });
        return result.event;
      },
    };
  }

  private assertTarget(eventType: string, payload: unknown): void {
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("targetInstanceId" in payload)
    ) {
      return;
    }
    const targetInstanceId = targetOf({ type: eventType, payload });
    const target = this.activeModules.get(targetInstanceId);
    const supported = target?.instance.subscriptions.some(
      (subscription) =>
        subscription.targeted && subscription.event.type === eventType,
    );
    if (supported !== true) {
      throw new ModuleTargetNotFoundError(eventType, targetInstanceId);
    }
  }
}

function groupSubscriptions(
  modules: readonly ActiveModule[],
): Map<string, ActiveSubscription[]> {
  const grouped = new Map<string, ActiveSubscription[]>();
  for (const module of modules) {
    for (const subscription of module.instance.subscriptions) {
      const current = grouped.get(subscription.event.type) ?? [];
      current.push({ module, subscription });
      grouped.set(subscription.event.type, current);
    }
  }
  return grouped;
}

function assertCompatibleSubscriptions(
  eventType: string,
  subscriptions: readonly ActiveSubscription[],
): void {
  const first = subscriptions[0];
  if (first === undefined) return;
  for (const current of subscriptions.slice(1)) {
    if (current.subscription.targeted !== first.subscription.targeted) {
      throw new Error(
        `Module event cannot mix broadcast and targeted subscriptions: ${eventType}`,
      );
    }
    if (current.subscription.event !== first.subscription.event) {
      throw new Error(`Conflicting module event definitions: ${eventType}`);
    }
  }
}

function targetOf(event: Pick<EventEnvelope, "payload" | "type">): string {
  if (
    typeof event.payload !== "object" ||
    event.payload === null ||
    !("targetInstanceId" in event.payload) ||
    typeof event.payload.targetInstanceId !== "string" ||
    event.payload.targetInstanceId.trim().length === 0
  ) {
    throw new TypeError(
      `Targeted module event ${event.type} requires targetInstanceId`,
    );
  }
  return event.payload.targetInstanceId;
}

function parseSubscribedEvent<TType extends string, TPayload>(
  definition: EventDefinition<TType, TPayload>,
  event: EventEnvelope,
): EventEnvelope<TType, TPayload> {
  if (event.type !== definition.type) {
    throw new TypeError(`Expected ${definition.type}, received ${event.type}`);
  }
  return {
    ...structuredClone(event),
    type: definition.type,
    payload: definition.payloadSchema.parse(event.payload),
  };
}

function validateDerivedEvent<TType extends string, TPayload>(
  definition: EventDefinition<TType, TPayload>,
  original: EventEnvelope<TType, TPayload>,
  candidate: EventEnvelope,
): void {
  if (candidate.type !== definition.type) {
    throw new TypeError("Module event type cannot be rewritten");
  }
  if (
    candidate.traceId !== original.traceId ||
    candidate.sessionId !== original.sessionId
  ) {
    throw new TypeError("Module event identity cannot be rewritten");
  }
  definition.payloadSchema.parse(candidate.payload);
}

async function disposeModules(
  modules: readonly ActiveModule[],
): Promise<unknown[]> {
  const results = await Promise.allSettled(
    modules.map(({ instance }) => Promise.resolve(instance.dispose?.())),
  );
  return results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
}
