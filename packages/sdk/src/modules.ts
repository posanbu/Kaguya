import type { EventEnvelope } from "@kaguya/schema";
import { z } from "@kaguya/schema";

import type { EventDefinition, ExecutionContext } from "./index.js";

export interface ModuleManifest<TSettings = unknown> {
  readonly apiVersion: 1;
  readonly definitionId: string;
  readonly displayName: string;
  readonly settingsSchema: z.ZodType<TSettings>;
}

export interface ModuleActivation {
  readonly instanceId: string;
  readonly definitionId: string;
  readonly settings: unknown;
}

export interface TargetedModulePayload {
  readonly targetInstanceId: string;
}

export interface ModuleHandlerContext extends ExecutionContext {
  readonly definitionId: string;
  readonly instanceId: string;
  readonly sourceEvent: EventEnvelope;
  emit<TType extends string, TPayload>(
    definition: EventDefinition<TType, TPayload>,
    payload: TPayload,
    metadata?: Record<string, unknown>,
  ): Promise<EventEnvelope<TType, TPayload>>;
}

export interface ModuleSubscription {
  readonly event: EventDefinition<string, unknown>;
  readonly targeted: boolean;
  readonly handle: (
    event: EventEnvelope,
    context: ModuleHandlerContext,
  ) => Promise<void> | void;
}

export interface ModuleInstance {
  readonly subscriptions: readonly ModuleSubscription[];
  dispose?(): Promise<void> | void;
}

export interface CreateModuleInstanceOptions<TSettings> {
  readonly instanceId: string;
  readonly settings: TSettings;
}

export interface ModuleDefinition<TSettings = unknown> {
  readonly manifest: ModuleManifest<TSettings>;
  create(
    options: CreateModuleInstanceOptions<TSettings>,
  ): Promise<ModuleInstance> | ModuleInstance;
}

export function defineModule<TSettings>(
  definition: ModuleDefinition<TSettings>,
): ModuleDefinition<TSettings> {
  assertNonBlank(definition.manifest.definitionId, "module definition id");
  assertNonBlank(definition.manifest.displayName, "module display name");
  if (definition.manifest.apiVersion !== 1) {
    throw new Error("unsupported module API version");
  }
  return definition;
}

export function onEvent<TType extends string, TPayload>(
  event: EventDefinition<TType, TPayload>,
  handle: (
    event: EventEnvelope<TType, TPayload>,
    context: ModuleHandlerContext,
  ) => Promise<void> | void,
): ModuleSubscription {
  return {
    event: event as EventDefinition<string, unknown>,
    targeted: false,
    handle: handle as ModuleSubscription["handle"],
  };
}

export function onTargetedEvent<
  TType extends string,
  TPayload extends TargetedModulePayload,
>(
  event: EventDefinition<TType, TPayload>,
  handle: (
    event: EventEnvelope<TType, TPayload>,
    context: ModuleHandlerContext,
  ) => Promise<void> | void,
): ModuleSubscription {
  return {
    event: event as EventDefinition<string, unknown>,
    targeted: true,
    handle: handle as ModuleSubscription["handle"],
  };
}

function assertNonBlank(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
}
