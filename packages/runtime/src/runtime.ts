import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { KaguyaDatabase } from "@kaguya/database";
import { EventBus, ModuleHost } from "@kaguya/engine";
import {
  KaguyaLlmClient,
  type KaguyaLlmModelResolver,
} from "@kaguya/llm/client";
import { createRepeatingDeterministicModel } from "@kaguya/llm/testing";
import {
  createModuleLogger,
  runWithLogContext,
  type KaguyaLogger,
} from "@kaguya/logger";
import {
  alwaysReplyFilterModule,
  createLlmReplyModule,
  messageIngestedEvent,
  moduleMessageSchema,
  outboundMessageDeliveredEvent,
  outboundMessageFailedEvent,
  outboundMessageRequestedEvent,
  type ModuleModelSelection,
  type ReplyLlmExecutor,
} from "@kaguya/modules";
import type {
  PlatformDeliveryReceipt,
  PlatformInboundMessage,
  PlatformOutboundTransport,
} from "@kaguya/platform-adapters";
import { PromptCompiler } from "@kaguya/prompt";
import type {
  EventEnvelope,
  MessageRecord,
  OutboundMessageRecord,
} from "@kaguya/schema";
import type { ModuleActivation, ModuleDefinition } from "@kaguya/sdk";

import { approvedEventDefinitions } from "./events.js";
import { LlmLifecycleClient } from "./llm-lifecycle.js";
import { GatewayAllowlist } from "./gateway-allowlist.js";

const SESSION_MESSAGE_PAGE_LIMIT = 200;

export interface RuntimeWebMessage {
  readonly kind: "web";
  readonly requestId: string;
  readonly sessionId: string;
  readonly text: string;
  readonly occurredAt?: string;
}

export interface RuntimePlatformMessage {
  readonly kind: "platform";
  readonly message: PlatformInboundMessage;
}

export type RuntimeInboundMessage = RuntimeWebMessage | RuntimePlatformMessage;

export interface RuntimeDispatchResult {
  readonly traceId: string;
  readonly workflowId: "message-module-pipeline";
  readonly completedNodeIds: readonly string[];
  readonly deliveries: readonly PlatformDeliveryReceipt[];
  readonly delivery?: PlatformDeliveryReceipt;
  readonly interrupted: boolean;
  readonly filtered: boolean;
}

export interface RuntimeEnqueueReceipt {
  readonly traceId: string;
  readonly messageId: string;
  readonly sessionId: string;
}

export interface SessionMessageView {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly occurredAt: string;
  readonly requestId?: string;
}

export interface ResolvedRuntimeModel {
  readonly modelId: string;
  readonly model: ReturnType<KaguyaLlmModelResolver>;
}

export type RuntimeModelSelectionResolver = (
  selection: ModuleModelSelection,
) => ResolvedRuntimeModel;

export interface RuntimeTransportRegistration {
  readonly adapterId: string;
  readonly platform: string;
  readonly transport: PlatformOutboundTransport;
}

export interface KaguyaRuntimeOptions {
  readonly databasePath: string;
  readonly logger?: KaguyaLogger;
  readonly now?: () => Date;
  readonly resolveModelSelection?: RuntimeModelSelectionResolver;
  readonly moduleDefinitions?: readonly ModuleDefinition[];
  readonly moduleActivations?: readonly ModuleActivation[];
  readonly gatewayAllowlist?: GatewayAllowlist;
}

export class RuntimeUnavailableError extends Error {
  constructor(message = "Kaguya runtime is not accepting messages") {
    super(message);
    this.name = "RuntimeUnavailableError";
  }
}

export class OutboundTransportNotFoundError extends Error {
  constructor(
    readonly adapterId: string,
    readonly platform: string,
  ) {
    super(`Outbound transport is not registered: ${adapterId} (${platform})`);
    this.name = "OutboundTransportNotFoundError";
  }
}

export class OutboundTransportError extends Error {
  override readonly cause: unknown;

  constructor(
    readonly adapterId: string,
    readonly platform: string,
    cause: unknown,
  ) {
    super(`Outbound transport failed: ${adapterId} (${platform})`, { cause });
    this.name = "OutboundTransportError";
    this.cause = cause;
  }
}

type RuntimeState = "new" | "started" | "closing" | "closed";

export class KaguyaRuntime {
  readonly #now: () => Date;
  readonly #inFlight = new Set<Promise<RuntimeDispatchResult>>();
  readonly #transports = new Map<string, RuntimeTransportRegistration>();
  readonly #traceSequences = new Map<string, number>();
  readonly #runtimeLogger: KaguyaLogger | undefined;
  readonly #eventLogger: KaguyaLogger | undefined;

  #state: RuntimeState = "new";
  #closePromise: Promise<void> | undefined;
  #database: KaguyaDatabase | undefined;
  #eventBus: EventBus | undefined;
  #moduleHost: ModuleHost | undefined;
  #unsubscribeOutbound: (() => void) | undefined;

  constructor(private readonly options: KaguyaRuntimeOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#runtimeLogger = optionalModuleLogger(options.logger, "runtime");
    this.#eventLogger = optionalModuleLogger(options.logger, "runtime:event");
  }

  registerTransport(registration: RuntimeTransportRegistration): void {
    if (this.#state !== "new") {
      throw new RuntimeUnavailableError(
        "Outbound transports can only be registered before runtime start",
      );
    }
    const key = transportKey(registration.adapterId, registration.platform);
    if (this.#transports.has(key)) {
      throw new Error(`Duplicate outbound transport: ${key}`);
    }
    this.#transports.set(key, registration);
  }

  async start(): Promise<void> {
    if (this.#state === "started") return;
    if (this.#state !== "new") {
      throw new RuntimeUnavailableError("Kaguya runtime cannot be restarted");
    }

    mkdirSync(dirname(this.options.databasePath), { recursive: true });
    const database = KaguyaDatabase.open(this.options.databasePath);
    let moduleHost: ModuleHost | undefined;
    try {
      database.migrate();
      const eventBus = new EventBus({
        onObserverError: (error) => {
          this.#eventLogger?.error(
            { event: "event.observer.failed", err: error },
            "Event observer failed",
          );
        },
      });
      const promptCompiler = new PromptCompiler();
      const llm = createReplyLlmExecutor({
        database,
        eventBus,
        now: this.#now,
        resolveModelSelection:
          this.options.resolveModelSelection ??
          createDeterministicModelSelectionResolver(),
      });
      const replyModule = createLlmReplyModule({
        messageReader: database.messages,
        llm,
        promptCompiler,
        messageWriter: database.messages,
      });
      moduleHost = new ModuleHost({
        eventBus,
        now: this.#now,
        nextId: (traceId, prefix) => this.#nextId(traceId, prefix),
      });
      for (const definition of this.options.moduleDefinitions ?? [
        alwaysReplyFilterModule,
        replyModule,
      ]) {
        moduleHost.register(definition);
      }

      this.#database = database;
      this.#eventBus = eventBus;
      this.#moduleHost = moduleHost;
      this.#unsubscribeOutbound = eventBus.subscribe(
        outboundMessageRequestedEvent.type,
        async (event) => {
          await this.#deliverOutbound(event);
          return { continue: true, event };
        },
        { priority: 100 },
      );
      this.#registerEventObservers(eventBus);
      await moduleHost.start(
        this.options.moduleActivations ?? defaultModuleActivations(),
      );
      this.#state = "started";
      this.#runtimeLogger?.info(
        {
          event: "runtime.started",
          transportCount: this.#transports.size,
        },
        "Kaguya runtime started",
      );
    } catch (error) {
      this.#unsubscribeOutbound?.();
      this.#unsubscribeOutbound = undefined;
      await moduleHost?.stop().catch(() => undefined);
      database.close();
      this.#database = undefined;
      this.#eventBus = undefined;
      this.#moduleHost = undefined;
      this.#state = "closed";
      throw error;
    }
  }

  dispatch(message: RuntimeInboundMessage): Promise<RuntimeDispatchResult> {
    if (this.#state !== "started") {
      return Promise.reject(new RuntimeUnavailableError());
    }
    const operation = this.#dispatch(message);
    this.#inFlight.add(operation);
    void operation.then(
      () => this.#inFlight.delete(operation),
      () => this.#inFlight.delete(operation),
    );
    return operation;
  }

  enqueue(
    message: Omit<RuntimeWebMessage, "kind">,
  ): Promise<RuntimeEnqueueReceipt> {
    if (this.#state !== "started") {
      return Promise.reject(new RuntimeUnavailableError());
    }
    const startedAt = this.#now().getTime();
    const webMessage: RuntimeWebMessage = { kind: "web", ...message };
    const ingested = this.#ingest(webMessage);
    const processing = runWithLogContext(
      { traceId: ingested.traceId },
      async () => {
        try {
          return await this.#process(ingested, webMessage, startedAt);
        } catch (error) {
          this.#runtimeLogger?.error(
            {
              event: "message.processing.failed",
              sourceKind: "web",
              durationMs: Math.max(0, this.#now().getTime() - startedAt),
              err: error,
            },
            "Background message processing failed",
          );
          throw error;
        }
      },
    );
    this.#inFlight.add(processing);
    void processing.then(
      () => this.#inFlight.delete(processing),
      () => this.#inFlight.delete(processing),
    );
    return Promise.resolve({
      traceId: ingested.traceId,
      messageId: ingested.record.id,
      sessionId: message.sessionId,
    });
  }

  listSessionMessages(
    sessionId: string,
    options?: { limit?: number },
  ): Promise<readonly SessionMessageView[]> {
    if (this.#state !== "started") {
      return Promise.reject(new RuntimeUnavailableError());
    }
    const limit = options?.limit ?? SESSION_MESSAGE_PAGE_LIMIT;
    return Promise.resolve(
      required(this.#database, "database")
        .messages.listBySession(sessionId, limit)
        .flatMap((record) => {
          if (record.role !== "user" && record.role !== "assistant") {
            return [];
          }
          const requestId = sessionRequestId(record);
          return [
            {
              id: record.id,
              role: record.role,
              content: record.content,
              occurredAt: record.occurredAt,
              ...(requestId === undefined ? {} : { requestId }),
            },
          ];
        }),
    );
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    if (this.#state === "closed") return Promise.resolve();

    this.#state = "closing";
    this.#closePromise = (async () => {
      await Promise.allSettled([...this.#inFlight]);
      const failures: unknown[] = [];
      this.#unsubscribeOutbound?.();
      this.#unsubscribeOutbound = undefined;
      try {
        await this.#moduleHost?.stop();
      } catch (error) {
        failures.push(error);
      }
      try {
        this.#database?.close();
      } catch (error) {
        failures.push(error);
      }
      this.#database = undefined;
      this.#eventBus = undefined;
      this.#moduleHost = undefined;
      this.#state = "closed";
      this.#runtimeLogger?.info(
        { event: "runtime.stopped", failureCount: failures.length },
        "Kaguya runtime stopped",
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "Kaguya runtime shutdown failed");
      }
    })();
    return this.#closePromise;
  }

  async #dispatch(
    input: RuntimeInboundMessage,
  ): Promise<RuntimeDispatchResult> {
    const traceId = traceIdOf(input);
    const startedAt = this.#now().getTime();
    return runWithLogContext({ traceId }, async () => {
      if (
        input.kind === "platform" &&
        this.options.gatewayAllowlist?.allows(input.message) === false
      ) {
        this.#runtimeLogger?.info(
          {
            event: "message.dispatch.filtered",
            sourceKind: input.kind,
            durationMs: Math.max(0, this.#now().getTime() - startedAt),
            ...platformLogFields(input),
          },
          "Message filtered by gateway allowlist",
        );
        return {
          traceId,
          workflowId: "message-module-pipeline" as const,
          completedNodeIds: [],
          deliveries: [],
          interrupted: true,
          filtered: true,
        };
      }

      try {
        const ingested = this.#ingest(input);
        return await this.#process(ingested, input, startedAt);
      } catch (error) {
        this.#runtimeLogger?.error(
          {
            event: "message.dispatch.failed",
            sourceKind: input.kind,
            durationMs: Math.max(0, this.#now().getTime() - startedAt),
            err: error,
            ...platformLogFields(input),
          },
          "Message dispatch failed",
        );
        throw error;
      }
    });
  }

  #ingest(input: RuntimeInboundMessage): IngestedMessage {
    const normalized = normalizeInboundMessage(input, this.#now, (prefix) =>
      this.#nextId(traceIdOf(input), prefix),
    );
    this.#runtimeLogger?.debug(
      {
        event: "message.dispatch.started",
        sourceKind: input.kind,
        ...platformLogFields(input),
      },
      "Message dispatch started",
    );
    required(this.#database, "database").messages.insert(normalized.record);
    return normalized;
  }

  async #process(
    ingested: IngestedMessage,
    input: RuntimeInboundMessage,
    startedAt: number,
  ): Promise<RuntimeDispatchResult> {
    const result = await required(this.#eventBus, "event bus").emit(
      ingested.event,
    );
    const deliveries = deliveryReceipts(
      required(this.#database, "database").outboundMessages.listByTrace(
        ingested.traceId,
      ),
    );
    const durationMs = Math.max(0, this.#now().getTime() - startedAt);
    const lastDelivery = deliveries.at(-1);
    this.#runtimeLogger?.info(
      {
        event: "message.dispatch.completed",
        sourceKind: input.kind,
        durationMs,
        deliveryCount: deliveries.length,
        interrupted: !result.continue,
        ...platformLogFields(input),
      },
      "Message dispatch completed",
    );
    return {
      traceId: ingested.traceId,
      workflowId: "message-module-pipeline",
      completedNodeIds: ["persist-message", "publish-message-ingested"],
      deliveries,
      ...(lastDelivery === undefined ? {} : { delivery: lastDelivery }),
      interrupted: !result.continue,
      filtered: false,
    };
  }

  async #deliverOutbound(event: EventEnvelope): Promise<void> {
    const payload = outboundMessageRequestedEvent.payloadSchema.parse(
      event.payload,
    );
    const database = required(this.#database, "database");
    const id = this.#nextId(event.traceId, "outbound-message");
    const requested: Extract<OutboundMessageRecord, { status: "requested" }> = {
      id,
      traceId: event.traceId,
      adapterId: payload.adapterId,
      platform: payload.platform,
      destination: payload.destination,
      message: payload.message,
      occurredAt: this.#now().toISOString(),
      status: "requested",
      metadata: {
        requestEventId: event.id,
        ...(typeof event.metadata.causationEventId === "string"
          ? { causationEventId: event.metadata.causationEventId }
          : {}),
        ...(typeof event.metadata.rootEventId === "string"
          ? { rootEventId: event.metadata.rootEventId }
          : {}),
        ...(typeof event.metadata.moduleDefinitionId === "string"
          ? { moduleDefinitionId: event.metadata.moduleDefinitionId }
          : {}),
        ...(typeof event.metadata.moduleInstanceId === "string"
          ? { moduleInstanceId: event.metadata.moduleInstanceId }
          : {}),
      },
    };
    database.outboundMessages.insert(requested);

    const registration = this.#transports.get(
      transportKey(payload.adapterId, payload.platform),
    );
    if (registration === undefined) {
      const error = new OutboundTransportNotFoundError(
        payload.adapterId,
        payload.platform,
      );
      const failed = failedOutbound(requested, this.#now, error.message);
      database.outboundMessages.complete(failed);
      await this.#emitOutboundResult(event, failed);
      throw error;
    }

    let receipt: PlatformDeliveryReceipt;
    try {
      receipt = await registration.transport.sendMessage(
        payload.destination,
        payload.message,
        { traceId: event.traceId, outboundMessageId: id },
      );
    } catch (cause) {
      const error = new OutboundTransportError(
        payload.adapterId,
        payload.platform,
        cause,
      );
      const failed = failedOutbound(
        requested,
        this.#now,
        "Platform transport failed",
      );
      database.outboundMessages.complete(failed);
      await this.#emitOutboundResult(event, failed);
      throw error;
    }
    if (receipt.ok) {
      const delivered: Extract<OutboundMessageRecord, { status: "delivered" }> =
        {
          ...requested,
          status: "delivered",
          completedAt: this.#now().toISOString(),
          receipt: safeReceipt(receipt),
        };
      database.outboundMessages.complete(delivered);
      await this.#emitOutboundResult(event, delivered);
      return;
    }
    const failed = failedOutbound(
      requested,
      this.#now,
      "Platform delivery failed",
    );
    database.outboundMessages.complete(failed);
    await this.#emitOutboundResult(event, failed);
  }

  async #emitOutboundResult(
    source: EventEnvelope,
    record:
      | Extract<OutboundMessageRecord, { status: "delivered" }>
      | Extract<OutboundMessageRecord, { status: "failed" }>,
  ): Promise<void> {
    const basePayload = {
      outboundMessageId: record.id,
      adapterId: record.adapterId,
      platform: record.platform,
    };
    const resultEvent =
      record.status === "delivered"
        ? outboundMessageDeliveredEvent.create(
            outboundResultBase(source, this.#now, (prefix) =>
              this.#nextId(source.traceId, prefix),
            ),
            basePayload,
          )
        : outboundMessageFailedEvent.create(
            outboundResultBase(source, this.#now, (prefix) =>
              this.#nextId(source.traceId, prefix),
            ),
            { ...basePayload, error: record.error },
          );
    await required(this.#eventBus, "event bus").emit(resultEvent);
  }

  #nextId(traceId: string, prefix: string): string {
    const sequence = (this.#traceSequences.get(traceId) ?? 0) + 1;
    this.#traceSequences.set(traceId, sequence);
    return `${traceId}-${prefix}-${String(sequence).padStart(6, "0")}`;
  }

  #registerEventObservers(eventBus: EventBus): void {
    for (const definition of approvedEventDefinitions) {
      eventBus.subscribe(
        definition.type,
        (event) => {
          runWithLogContext({ eventId: event.id }, () => {
            this.#eventLogger?.debug(
              {
                event: "event.emitted",
                eventType: event.type,
                eventSource: event.source,
              },
              "Runtime event emitted",
            );
          });
        },
        { mode: "observe" },
      );
    }
  }
}

function outboundResultBase(
  source: EventEnvelope,
  now: () => Date,
  nextId: (prefix: string) => string,
) {
  return {
    id: nextId("event"),
    source: "runtime:outbound-transport",
    occurredAt: now().toISOString(),
    traceId: source.traceId,
    metadata: {
      causationEventId: source.id,
      rootEventId:
        typeof source.metadata.rootEventId === "string"
          ? source.metadata.rootEventId
          : source.id,
    },
  };
}

interface IngestedMessage {
  readonly traceId: string;
  readonly record: MessageRecord;
  readonly event: ReturnType<typeof messageIngestedEvent.create>;
}

function normalizeInboundMessage(
  input: RuntimeInboundMessage,
  now: () => Date,
  nextId: (prefix: string) => string,
): IngestedMessage {
  const traceId = traceIdOf(input);
  const occurredAt =
    input.kind === "web"
      ? (input.occurredAt ?? now().toISOString())
      : input.message.occurredAt;
  const messageId = nextId("message");
  const moduleMessage = moduleMessageSchema.parse({
    messageId,
    text: input.kind === "web" ? input.text : input.message.text,
    occurredAt,
    source:
      input.kind === "web"
        ? {
            kind: "web",
            requestId: input.requestId,
            sessionId: input.sessionId,
          }
        : {
            kind: "platform",
            platform: input.message.platform,
            adapterId: input.message.adapterId,
            platformMessageId: input.message.platformMessageId,
            ...(input.message.selfId === undefined
              ? {}
              : { selfId: input.message.selfId }),
            destination: input.message.target,
            sender: {
              id: input.message.sender.userId,
              ...((input.message.sender.card ??
                input.message.sender.nickname) === undefined
                ? {}
                : {
                    displayName:
                      input.message.sender.card ??
                      input.message.sender.nickname,
                  }),
            },
            mentions: input.message.mentions,
          },
  });
  const eventId = nextId("event");
  const event = messageIngestedEvent.create(
    {
      id: eventId,
      source:
        input.kind === "web" ? "webui" : `adapter:${input.message.adapterId}`,
      occurredAt,
      traceId,
      metadata: { rootEventId: eventId },
    },
    { message: moduleMessage },
  );
  return {
    traceId,
    record: {
      id: messageId,
      role: "user",
      content: moduleMessage.text,
      occurredAt,
      metadata: {
        moduleMessage,
        traceId,
        eventId,
        ...(input.kind === "web" ? { sessionId: input.sessionId } : {}),
      },
    },
    event,
  };
}

function sessionRequestId(record: MessageRecord): string | undefined {
  const metadata = record.metadata;
  if (typeof metadata.requestId === "string" && metadata.requestId.length > 0) {
    return metadata.requestId;
  }
  const parsed = moduleMessageSchema.safeParse(metadata.moduleMessage);
  if (parsed.success && parsed.data.source.kind === "web") {
    return parsed.data.source.requestId;
  }
  return undefined;
}

function createReplyLlmExecutor(options: {
  database: KaguyaDatabase;
  eventBus: EventBus;
  now: () => Date;
  resolveModelSelection: RuntimeModelSelectionResolver;
}): ReplyLlmExecutor {
  return {
    async generate(request, context) {
      const resolved = options.resolveModelSelection(request.selection);
      const lifecycle = new LlmLifecycleClient(
        new KaguyaLlmClient({
          model: resolved.model,
          traceWriter: options.database.llmTraces,
          now: options.now,
        }),
        options.eventBus,
      );
      return lifecycle.generate(
        {
          kind: request.kind,
          modelId: resolved.modelId,
          prompt: request.prompt,
          traceId: request.traceId,
          workflowId: request.workflowId,
          nodeId: request.nodeId,
        },
        context,
      );
    },
  };
}

function createDeterministicModelSelectionResolver(): RuntimeModelSelectionResolver {
  const model = createRepeatingDeterministicModel({
    text: "It is a lovely night for watching the moon.",
  });
  return ({ modelTier }) => ({
    modelId: `deterministic-${modelTier}`,
    model,
  });
}

function defaultModuleActivations(): readonly ModuleActivation[] {
  return [
    {
      instanceId: "filter.default",
      definitionId: "demo.filter.always",
      settings: { replyTargetInstanceId: "reply.default" },
    },
    {
      instanceId: "reply.default",
      definitionId: "demo.reply.llm",
      settings: {
        modelTier: "heavy",
        outbound: { mode: "source", messageKind: "reply" },
      },
    },
  ];
}

function failedOutbound(
  requested: Extract<OutboundMessageRecord, { status: "requested" }>,
  now: () => Date,
  error: string,
): Extract<OutboundMessageRecord, { status: "failed" }> {
  return {
    ...requested,
    status: "failed",
    completedAt: now().toISOString(),
    error,
  };
}

function safeReceipt(
  receipt: PlatformDeliveryReceipt,
): Record<string, unknown> {
  return {
    ok: receipt.ok,
    adapterId: receipt.adapterId,
    platform: receipt.platform,
    ...(receipt.platformMessageId === undefined
      ? {}
      : { platformMessageId: receipt.platformMessageId }),
  };
}

function deliveryReceipts(
  records: readonly OutboundMessageRecord[],
): PlatformDeliveryReceipt[] {
  return records.flatMap((record) => {
    if (record.status === "requested") return [];
    return [
      {
        ok: record.status === "delivered",
        adapterId: record.adapterId,
        platform: record.platform as PlatformDeliveryReceipt["platform"],
        target: record.destination,
        ...(record.status === "delivered" &&
        typeof record.receipt.platformMessageId === "string"
          ? { platformMessageId: record.receipt.platformMessageId }
          : {}),
        ...(record.status === "failed" ? { error: record.error } : {}),
      },
    ];
  });
}

function traceIdOf(input: RuntimeInboundMessage): string {
  return input.kind === "web"
    ? `webui-${input.requestId}`
    : input.message.traceId;
}

function platformLogFields(
  input: RuntimeInboundMessage,
): Record<string, unknown> {
  return input.kind === "platform"
    ? {
        adapterId: input.message.adapterId,
        platform: input.message.platform,
        targetKind: input.message.target.kind,
      }
    : {};
}

function transportKey(adapterId: string, platform: string): string {
  return `${platform}:${adapterId}`;
}

function optionalModuleLogger(
  logger: KaguyaLogger | undefined,
  namespace: string,
): KaguyaLogger | undefined {
  return logger === undefined
    ? undefined
    : createModuleLogger(logger, namespace);
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new RuntimeUnavailableError(`${label} is not initialized`);
  }
  return value;
}
