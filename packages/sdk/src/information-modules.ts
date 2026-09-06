import type {
  DeepReadonly,
  InformationAtom,
  InformationReference,
  JsonObject,
} from "@kaguya/schema";
import type {
  InformationAppendInput,
  InformationKindDefinition,
} from "./information-kind.js";
import { z } from "@kaguya/schema";

export interface InformationModuleManifest<TSettings = unknown> {
  readonly apiVersion: 1;
  readonly definitionId: string;
  readonly displayName: string;
  readonly settingsSchema: z.ZodType<TSettings>;
  readonly informationKinds: readonly InformationKindDefinition<string, any>[];
}

export interface InformationModuleActivation {
  readonly instanceId: string;
  readonly definitionId: string;
  readonly settings: unknown;
}

export interface InformationModuleHandlerContext extends InformationExecutionContext {
  readonly definitionId: string;
  readonly instanceId: string;
  readonly sourceAtom: DeepReadonly<InformationAtom>;
  append<K extends string, P extends JsonObject>(
    definition: InformationKindDefinition<K, P>,
    input: Omit<InformationAppendInput<K, P>, "kind" | "occurredAt" | "source" | "references"> & {
      readonly references?: readonly InformationReference[];
    },
  ): Promise<DeepReadonly<InformationAtom<K, P>>>;
}

export interface InformationExecutionContext {
  now(): Date;
}

export interface InformationModuleSubscription {
  readonly kind: string;
  readonly targeted: boolean;
  readonly handle: (
    atom: DeepReadonly<InformationAtom>,
    context: InformationModuleHandlerContext,
  ) => Promise<void> | void;
}

export interface InformationModuleInstance {
  readonly subscriptions: readonly InformationModuleSubscription[];
  dispose?(): Promise<void> | void;
}

export interface CreateInformationModuleInstanceOptions<TSettings> {
  readonly instanceId: string;
  readonly settings: TSettings;
}

export interface InformationModuleDefinition<TSettings = unknown> {
  readonly manifest: InformationModuleManifest<TSettings>;
  create(
    options: CreateInformationModuleInstanceOptions<TSettings>,
  ): Promise<InformationModuleInstance> | InformationModuleInstance;
}

export function defineInformationModule<TSettings>(
  definition: InformationModuleDefinition<TSettings>,
): InformationModuleDefinition<TSettings> {
  assertNonBlank(definition.manifest.definitionId, "module definition id");
  assertNonBlank(definition.manifest.displayName, "module display name");
  if (definition.manifest.apiVersion !== 1) {
    throw new Error("unsupported information module API version");
  }
  if (!Array.isArray(definition.manifest.informationKinds)) {
    throw new Error("information module kinds must be an array");
  }
  const kinds = new Set<string>();
  for (const kind of definition.manifest.informationKinds) {
    if (kinds.has(kind.kind)) {
      throw new Error(`Duplicate information module kind: ${kind.kind}`);
    }
    kinds.add(kind.kind);
  }
  return definition;
}

export function onInformation<K extends string, P extends JsonObject>(
  definition: InformationKindDefinition<K, P>,
  handle: (
    atom: DeepReadonly<InformationAtom<K, P>>,
    context: InformationModuleHandlerContext,
  ) => Promise<void> | void,
): InformationModuleSubscription {
  return {
    kind: definition.kind,
    targeted: false,
    handle: handle as InformationModuleSubscription["handle"],
  };
}

export function onTargetedInformation<
  K extends string,
  P extends JsonObject,
>(
  definition: InformationKindDefinition<K, P>,
  handle: (
    atom: DeepReadonly<InformationAtom<K, P>>,
    context: InformationModuleHandlerContext,
  ) => Promise<void> | void,
): InformationModuleSubscription {
  return {
    kind: definition.kind,
    targeted: true,
    handle: handle as InformationModuleSubscription["handle"],
  };
}

export interface InformationModuleRunLifecycle {
  started(input: InformationModuleRunLifecycleInput): Promise<void> | void;
  completed(input: InformationModuleRunLifecycleInput): Promise<void> | void;
  failed(
    input: InformationModuleRunLifecycleInput & { readonly error: unknown },
  ): Promise<void> | void;
  cancelled(
    input: InformationModuleRunLifecycleInput & { readonly error?: unknown },
  ): Promise<void> | void;
}

export interface InformationModuleRunLifecycleInput {
  readonly definitionId: string;
  readonly instanceId: string;
  readonly sourceAtom: DeepReadonly<InformationAtom>;
}

function assertNonBlank(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
}
