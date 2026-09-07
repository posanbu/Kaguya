import type {
  DeepReadonly,
  InformationAtom,
  InformationId,
  JsonObject,
} from "@kaguya/schema";
import { z } from "@kaguya/schema";
import {
  defineInformationKind,
  type InformationFindQuery,
  type InformationKindDefinition,
  type InformationRegistrationInput,
} from "@kaguya/sdk";

/** Scheduler 只依赖 Core 的稳定结构端口，避免 scheduler 与 engine 形成包循环。 */
export interface CadenceInformationCore {
  onDurable<K extends string, P extends JsonObject>(
    subscriptionId: string,
    definition: InformationKindDefinition<K, P>,
    handle: (
      atom: DeepReadonly<InformationAtom<K, P>>,
      signal: AbortSignal,
    ) => Promise<void> | void,
  ): () => void;
  registerOnce<K extends string, P extends JsonObject>(
    operation: string,
    key: string,
    definition: InformationKindDefinition<K, P>,
    input: InformationRegistrationInput<K, P>,
  ): Promise<DeepReadonly<InformationAtom<K, P>>>;
  commitTerminal<K extends string, P extends JsonObject>(
    group: string,
    subjectInformationId: InformationId,
    definition: InformationKindDefinition<K, P>,
    input: InformationRegistrationInput<K, P>,
  ): Promise<DeepReadonly<InformationAtom>>;
  find(
    query: InformationFindQuery,
  ): Promise<readonly DeepReadonly<InformationAtom>[]>;
}

export const cadenceDefinitionPayloadSchema = z
  .object({
    anchor: z.string().datetime({ offset: true }),
    intervalMs: z.number().int().positive(),
    policyVersion: z.literal("coalesce.v1"),
    activationRevision: z.string().min(1),
    scopeKey: z.string().min(1),
  })
  .strict();
export type CadenceDefinitionPayload = z.infer<
  typeof cadenceDefinitionPayloadSchema
>;

export const cadenceTickPayloadSchema = z
  .object({
    definitionInformationId: z.string().min(1),
    windowIndex: z.number().int().nonnegative(),
    scheduledAt: z.string().datetime({ offset: true }),
    asOf: z.string().datetime({ offset: true }),
    earliestMissedBoundary: z.string().datetime({ offset: true }),
    latestMissedBoundary: z.string().datetime({ offset: true }),
    missedCount: z.number().int().positive(),
    scopeKey: z.string().min(1),
    policyVersion: z.literal("coalesce.v1"),
  })
  .strict();
export type CadenceTickPayload = z.infer<typeof cadenceTickPayloadSchema>;

export const cadenceDisabledPayloadSchema = z
  .object({ reason: z.string().min(1) })
  .strict();
export const cadenceSupersededPayloadSchema = z
  .object({ replacementInformationId: z.string().min(1) })
  .strict();
export const reconciliationRequestedPayloadSchema = z
  .object({
    tickInformationId: z.string().min(1),
    scopeKey: z.string().min(1),
    batchSize: z.number().int().positive(),
  })
  .strict();
export const reconciliationCompletedPayloadSchema = z
  .object({
    processed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
  })
  .strict();
export const reconciliationFailedPayloadSchema = z
  .object({
    processed: z.number().int().nonnegative(),
    failed: z.number().int().positive(),
    error: z.string().min(1).max(500),
  })
  .strict();

export const cadenceDefinitionInformationKind = defineInformationKind({
  kind: "scheduler.cadence.definition",
  payloadSchema: cadenceDefinitionPayloadSchema,
  references: {},
  log: {
    enabled: true,
    level: "debug",
    project: ({ payload }) => ({
      event: "scheduler.cadence.definition",
      intervalMs: payload.intervalMs,
      policyVersion: payload.policyVersion,
    }),
  },
});
export const cadenceDisabledInformationKind = defineInformationKind({
  kind: "scheduler.cadence.disabled",
  payloadSchema: cadenceDisabledPayloadSchema,
  references: {
    "core:status-of": {
      required: true,
      multiple: false,
      targetKinds: [cadenceDefinitionInformationKind.kind],
    },
  },
  log: {
    enabled: true,
    level: "debug",
    project: ({ payload }) => ({
      event: "scheduler.cadence.lifecycle",
      status: "disabled",
      reason: payload.reason,
    }),
  },
});
export const cadenceSupersededInformationKind = defineInformationKind({
  kind: "scheduler.cadence.superseded",
  payloadSchema: cadenceSupersededPayloadSchema,
  references: {
    "core:status-of": {
      required: true,
      multiple: false,
      targetKinds: [cadenceDefinitionInformationKind.kind],
    },
  },
  log: {
    enabled: true,
    level: "debug",
    project: () => ({
      event: "scheduler.cadence.lifecycle",
      status: "superseded",
    }),
  },
});
export const cadenceTickInformationKind = defineInformationKind({
  kind: "scheduler.cadence.tick",
  payloadSchema: cadenceTickPayloadSchema,
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [cadenceDefinitionInformationKind.kind],
    },
  },
  log: {
    enabled: true,
    level: "debug",
    project: ({ payload }) => ({
      event: "scheduler.cadence.tick",
      windowIndex: payload.windowIndex,
      scheduledAt: payload.scheduledAt,
      missedCount: payload.missedCount,
      policyVersion: payload.policyVersion,
    }),
  },
});
export const reconciliationRequestedInformationKind = defineInformationKind({
  kind: "maintenance.projection.reconciliation.requested",
  payloadSchema: reconciliationRequestedPayloadSchema,
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [cadenceTickInformationKind.kind],
    },
  },
  log: {
    enabled: true,
    level: "debug",
    project: ({ payload }) => ({
      event: "maintenance.projection.reconciliation",
      status: "requested",
      batchSize: payload.batchSize,
    }),
  },
});
export const reconciliationCompletedInformationKind = defineInformationKind({
  kind: "maintenance.projection.reconciliation.completed",
  payloadSchema: reconciliationCompletedPayloadSchema,
  references: {
    "core:status-of": {
      required: true,
      multiple: false,
      targetKinds: [reconciliationRequestedInformationKind.kind],
    },
  },
  log: {
    enabled: true,
    level: "debug",
    project: ({ payload }) => ({
      event: "maintenance.projection.reconciliation",
      status: "completed",
      processed: payload.processed,
      failed: payload.failed,
      pending: payload.pending,
    }),
  },
});
export const reconciliationFailedInformationKind = defineInformationKind({
  kind: "maintenance.projection.reconciliation.failed",
  payloadSchema: reconciliationFailedPayloadSchema,
  references: {
    "core:status-of": {
      required: true,
      multiple: false,
      targetKinds: [reconciliationRequestedInformationKind.kind],
    },
  },
  log: {
    enabled: true,
    level: "error",
    project: ({ payload }) => ({
      event: "maintenance.projection.reconciliation",
      status: "failed",
      processed: payload.processed,
      failed: payload.failed,
    }),
  },
});

export const cadenceInformationKinds = [
  cadenceDefinitionInformationKind,
  cadenceDisabledInformationKind,
  cadenceSupersededInformationKind,
  cadenceTickInformationKind,
  reconciliationRequestedInformationKind,
  reconciliationCompletedInformationKind,
  reconciliationFailedInformationKind,
] as const;

export interface CadenceDefinitionInput {
  readonly anchor: string;
  readonly intervalMs: number;
  readonly activationRevision: string;
  readonly scopeKey: string;
}

export interface CadenceWindow {
  readonly windowIndex: number;
  readonly scheduledAt: Date;
  readonly earliestMissedBoundary: Date;
  readonly missedCount: number;
}

export function computeCadenceWindow(
  anchor: Date,
  intervalMs: number,
  now: Date,
  lastWindowIndex: number,
): CadenceWindow | undefined {
  const latestIndex = Math.floor(
    (now.getTime() - anchor.getTime()) / intervalMs,
  );
  if (latestIndex < 0 || latestIndex <= lastWindowIndex) return undefined;
  const earliestIndex = Math.max(0, lastWindowIndex + 1);
  return {
    windowIndex: latestIndex,
    scheduledAt: boundary(anchor, intervalMs, latestIndex),
    earliestMissedBoundary: boundary(anchor, intervalMs, earliestIndex),
    missedCount: latestIndex - earliestIndex + 1,
  };
}

export interface CadenceTimerApi {
  setTimeout(
    handler: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface CadenceCoordinatorOptions {
  readonly core: CadenceInformationCore;
  readonly definitions: readonly CadenceDefinitionInput[];
  readonly now?: () => Date;
  readonly pollIntervalMs?: number;
  readonly timers?: CadenceTimerApi;
  readonly source?: string;
  readonly onError?: (error: unknown) => void;
}

export interface ProjectionReconciliationRunner {
  projectPendingBatch(): Promise<{
    readonly processed: number;
    readonly failed: number;
    readonly pending: number;
  }>;
}

export function installProjectionReconciliationConsumers(
  core: CadenceInformationCore,
  runner: ProjectionReconciliationRunner,
  batchSize = 100,
): readonly (() => void)[] {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000)
    throw new Error("Invalid reconciliation batch size");
  const removeTick = core.onDurable(
    "kaguya.maintenance.reconciliation.request",
    cadenceTickInformationKind,
    async (tick) => {
      const payload = cadenceTickInformationKind.payloadSchema.parse(
        tick.payload,
      );
      await core.registerOnce(
        "maintenance.projection.reconciliation",
        tick.informationId,
        reconciliationRequestedInformationKind,
        {
          occurredAt: new Date().toISOString(),
          source: "maintenance.projection.reconciliation",
          payload: {
            tickInformationId: tick.informationId,
            scopeKey: payload.scopeKey,
            batchSize,
          },
          references: [
            { relation: "core:caused-by", informationId: tick.informationId },
          ],
        },
      );
    },
  );
  const removeRequest = core.onDurable(
    "kaguya.maintenance.reconciliation.execute",
    reconciliationRequestedInformationKind,
    async (request) => {
      const payload =
        reconciliationRequestedInformationKind.payloadSchema.parse(
          request.payload,
        );
      let result: {
        readonly processed: number;
        readonly failed: number;
        readonly pending: number;
      };
      try {
        result = await runner.projectPendingBatch();
      } catch {
        await core.commitTerminal(
          "maintenance.projection.reconciliation",
          request.informationId,
          reconciliationFailedInformationKind,
          {
            occurredAt: new Date().toISOString(),
            source: "maintenance.projection.reconciliation",
            payload: {
              processed: 0,
              failed: 1,
              error: "log projection batch failed",
            },
            references: [
              {
                relation: "core:status-of",
                informationId: request.informationId,
              },
            ],
          },
        );
        return;
      }
      if (result.failed > 0) {
        await core.commitTerminal(
          "maintenance.projection.reconciliation",
          request.informationId,
          reconciliationFailedInformationKind,
          {
            occurredAt: new Date().toISOString(),
            source: "maintenance.projection.reconciliation",
            payload: {
              processed: result.processed,
              failed: result.failed,
              error: "log projection batch failed",
            },
            references: [
              {
                relation: "core:status-of",
                informationId: request.informationId,
              },
            ],
          },
        );
        return;
      }
      await core.commitTerminal(
        "maintenance.projection.reconciliation",
        request.informationId,
        reconciliationCompletedInformationKind,
        {
          occurredAt: new Date().toISOString(),
          source: "maintenance.projection.reconciliation",
          payload: {
            processed: result.processed,
            failed: 0,
            pending: result.pending,
          },
          references: [
            {
              relation: "core:status-of",
              informationId: request.informationId,
            },
          ],
        },
      );
      void payload;
    },
  );
  return [removeTick, removeRequest];
}

const defaultTimers: CadenceTimerApi = {
  setTimeout: (handler, delayMs) => globalThis.setTimeout(handler, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

export class CadenceCoordinator {
  readonly #options: CadenceCoordinatorOptions;
  readonly #now: () => Date;
  readonly #timers: CadenceTimerApi;
  readonly #onError: (error: unknown) => void;
  #definitions: Array<{
    input: CadenceDefinitionInput;
    atom: DeepReadonly<InformationAtom>;
  }> = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  #cycle: Promise<void> | undefined;

  constructor(options: CadenceCoordinatorOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#timers = options.timers ?? defaultTimers;
    this.#onError = options.onError ?? (() => undefined);
    validateDefinitions(options.definitions);
    if (
      !Number.isSafeInteger(options.pollIntervalMs ?? 1000) ||
      (options.pollIntervalMs ?? 1000) < 1
    )
      throw new Error("Cadence poll interval must be a positive integer");
  }

  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      this.#definitions = [];
      for (const input of this.#options.definitions) {
        const atom = await this.#options.core.registerOnce<
          "scheduler.cadence.definition",
          CadenceDefinitionPayload
        >(
          "scheduler.cadence.definition",
          `${input.activationRevision}:${input.scopeKey}`,
          cadenceDefinitionInformationKind,
          {
            occurredAt: this.#now().toISOString(),
            source: this.#options.source ?? "scheduler.cadence",
            payload: { ...input, policyVersion: "coalesce.v1" },
            references: [],
          },
        );
        this.#definitions.push({ input, atom });
      }
      await this.runOnce();
      this.schedule();
    } catch (error) {
      this.#running = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer !== undefined) this.#timers.clearTimeout(this.#timer);
    await this.#cycle;
  }

  async disable(
    definitionInformationId: InformationId,
    reason = "disabled",
  ): Promise<void> {
    await this.#options.core.registerOnce(
      "scheduler.cadence.disabled",
      definitionInformationId,
      cadenceDisabledInformationKind,
      {
        occurredAt: this.#now().toISOString(),
        source: this.#options.source ?? "scheduler.cadence",
        payload: { reason },
        references: [
          {
            relation: "core:status-of",
            informationId: definitionInformationId,
          },
        ],
      },
    );
  }

  async supersede(
    definitionInformationId: InformationId,
    replacementInformationId: InformationId,
  ): Promise<void> {
    await this.#options.core.registerOnce(
      "scheduler.cadence.superseded",
      definitionInformationId,
      cadenceSupersededInformationKind,
      {
        occurredAt: this.#now().toISOString(),
        source: this.#options.source ?? "scheduler.cadence",
        payload: { replacementInformationId },
        references: [
          {
            relation: "core:status-of",
            informationId: definitionInformationId,
          },
        ],
      },
    );
  }

  async runOnce(): Promise<void> {
    if (this.#cycle) return this.#cycle;
    this.#cycle = this.#runOnce().finally(() => {
      this.#cycle = undefined;
    });
    return this.#cycle;
  }

  async #runOnce(): Promise<void> {
    const now = this.#now();
    for (const definition of this.#definitions) {
      const payload = cadenceDefinitionInformationKind.payloadSchema.parse(
        definition.atom.payload,
      );
      const anchor = new Date(payload.anchor);
      const ticks = await this.#options.core.find({
        kinds: [cadenceTickInformationKind.kind],
        limit: 10000,
      });
      const statuses = await this.#options.core.find({
        kinds: [
          cadenceDisabledInformationKind.kind,
          cadenceSupersededInformationKind.kind,
        ],
        limit: 10000,
      });
      if (
        statuses.some((status) =>
          status.references.some(
            (reference) =>
              reference.relation === "core:status-of" &&
              reference.informationId === definition.atom.informationId,
          ),
        )
      )
        continue;
      const latestEmitted = ticks
        .map((tick) =>
          cadenceTickInformationKind.payloadSchema.safeParse(tick.payload)
            .success
            ? cadenceTickInformationKind.payloadSchema.parse(tick.payload)
            : undefined,
        )
        .filter(
          (tick): tick is CadenceTickPayload =>
            tick !== undefined &&
            tick.definitionInformationId === definition.atom.informationId,
        )
        .reduce((max, tick) => Math.max(max, tick.windowIndex), -1);
      const window = computeCadenceWindow(
        anchor,
        payload.intervalMs,
        now,
        latestEmitted,
      );
      if (window === undefined) continue;
      await this.#options.core.registerOnce(
        "scheduler.cadence.tick",
        `${definition.atom.informationId}:${window.windowIndex}`,
        cadenceTickInformationKind,
        {
          occurredAt: now.toISOString(),
          source: this.#options.source ?? "scheduler.cadence",
          payload: {
            definitionInformationId: definition.atom.informationId,
            windowIndex: window.windowIndex,
            scheduledAt: window.scheduledAt.toISOString(),
            asOf: window.scheduledAt.toISOString(),
            earliestMissedBoundary: window.earliestMissedBoundary.toISOString(),
            latestMissedBoundary: window.scheduledAt.toISOString(),
            missedCount: window.missedCount,
            scopeKey: payload.scopeKey,
            policyVersion: payload.policyVersion,
          },
          references: [
            {
              relation: "core:caused-by",
              informationId: definition.atom.informationId,
            },
          ],
        },
      );
    }
  }

  private schedule(): void {
    if (!this.#running) return;
    this.#timer = this.#timers.setTimeout(() => {
      void this.runOnce()
        .catch((error) => this.#onError(error))
        .finally(() => this.schedule());
    }, this.#options.pollIntervalMs ?? 1000);
  }
}

function boundary(anchor: Date, intervalMs: number, index: number): Date {
  return new Date(anchor.getTime() + index * intervalMs);
}

function validateDefinitions(
  definitions: readonly CadenceDefinitionInput[],
): void {
  for (const definition of definitions) {
    if (
      !Number.isSafeInteger(definition.intervalMs) ||
      definition.intervalMs < 1
    )
      throw new Error("Cadence interval must be a positive integer");
    if (Number.isNaN(Date.parse(definition.anchor)))
      throw new Error("Cadence anchor must be an ISO date");
    if (!definition.activationRevision.trim() || !definition.scopeKey.trim())
      throw new Error("Cadence identity must not be blank");
  }
}

export function cadenceKindDefinitions(): readonly InformationKindDefinition<
  string,
  any
>[] {
  return cadenceInformationKinds;
}
