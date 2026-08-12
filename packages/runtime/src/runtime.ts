import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { KaguyaDatabase } from "@kaguya/database";
import {
  EventBus,
  WorkflowEngine,
  type WorkflowExecutionResult,
  type WorkflowRunRecorder,
} from "@kaguya/engine";
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
import type {
  PlatformDeliveryReceipt,
  PlatformInboundMessage,
  PlatformReplySender,
} from "@kaguya/platform-adapters";
import { PromptCompiler } from "@kaguya/prompt";
import type { EventEnvelope, EventRun } from "@kaguya/schema";
import type { WorkflowContext, WorkflowDefinition } from "@kaguya/sdk";

import { dispatchEvent } from "./dispatch.js";
import { approvedEventDefinitions, messageReceivedEvent } from "./events.js";
import { LlmLifecycleClient } from "./llm-lifecycle.js";
import type { WorkflowServices } from "./services.js";
import { createMessageWorkflow } from "./workflows/message.js";

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
  readonly replySender: PlatformReplySender;
}

export type RuntimeInboundMessage = RuntimeWebMessage | RuntimePlatformMessage;

export interface RuntimeDispatchResult {
  readonly traceId: string;
  readonly workflowId: string;
  readonly completedNodeIds: readonly string[];
  readonly delivery?: PlatformDeliveryReceipt;
  readonly interrupted: boolean;
}

export interface KaguyaRuntimeOptions {
  readonly databasePath: string;
  readonly logger?: KaguyaLogger;
  readonly now?: () => Date;
  readonly resolveModel?: KaguyaLlmModelResolver;
}

export class RuntimeUnavailableError extends Error {
  constructor(message = "Kaguya runtime is not accepting messages") {
    super(message);
    this.name = "RuntimeUnavailableError";
  }
}

type RuntimeState = "new" | "started" | "closing" | "closed";

export class KaguyaRuntime {
  readonly #now: () => Date;
  readonly #inFlight = new Set<Promise<RuntimeDispatchResult>>();
  readonly #runtimeLogger: KaguyaLogger | undefined;
  readonly #eventLogger: KaguyaLogger | undefined;
  readonly #workflowLogger: KaguyaLogger | undefined;

  #state: RuntimeState = "new";
  #closePromise: Promise<void> | undefined;
  #database: KaguyaDatabase | undefined;
  #eventBus: EventBus | undefined;
  #engine: WorkflowEngine | undefined;
  #promptCompiler: PromptCompiler | undefined;
  #llmClient: LlmLifecycleClient | undefined;
  #messageWorkflow: WorkflowDefinition | undefined;

  constructor(private readonly options: KaguyaRuntimeOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#runtimeLogger = optionalModuleLogger(options.logger, "runtime");
    this.#eventLogger = optionalModuleLogger(options.logger, "runtime:event");
    this.#workflowLogger = optionalModuleLogger(
      options.logger,
      "runtime:workflow",
    );
  }

  async start(): Promise<void> {
    if (this.#state === "started") {
      return;
    }
    if (this.#state !== "new") {
      throw new RuntimeUnavailableError("Kaguya runtime cannot be restarted");
    }

    mkdirSync(dirname(this.options.databasePath), { recursive: true });
    const database = KaguyaDatabase.open(this.options.databasePath);
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
      const llmClient = new LlmLifecycleClient(
        new KaguyaLlmClient({
          resolveModel:
            this.options.resolveModel ?? createDeterministicModelResolver(),
          traceWriter: database.llmTraces,
          now: this.#now,
        }),
        eventBus,
      );
      const recorder = createLoggingRecorder(
        database.eventRuns,
        this.#workflowLogger,
      );

      this.#database = database;
      this.#eventBus = eventBus;
      this.#engine = new WorkflowEngine({ recorder });
      this.#promptCompiler = new PromptCompiler();
      this.#llmClient = llmClient;
      this.#messageWorkflow = createMessageWorkflow();
      this.#registerEventObservers(eventBus);
      this.#state = "started";
      this.#runtimeLogger?.info(
        { event: "runtime.started" },
        "Kaguya runtime started",
      );
    } catch (error) {
      database.close();
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

  close(): Promise<void> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    if (this.#state === "closed") {
      return Promise.resolve();
    }

    this.#state = "closing";
    this.#closePromise = (async () => {
      await Promise.allSettled([...this.#inFlight]);
      this.#database?.close();
      this.#database = undefined;
      this.#state = "closed";
      this.#runtimeLogger?.info(
        { event: "runtime.stopped" },
        "Kaguya runtime stopped",
      );
    })();
    return this.#closePromise;
  }

  async #dispatch(
    input: RuntimeInboundMessage,
  ): Promise<RuntimeDispatchResult> {
    const normalized = normalizeInboundMessage(input, this.#now);
    const startedAt = this.#now().getTime();
    return runWithLogContext(
      { traceId: normalized.traceId, sessionId: normalized.sessionId },
      async () => {
        this.#runtimeLogger?.debug(
          {
            event: "message.dispatch.started",
            sourceKind: input.kind,
            ...platformLogFields(input),
          },
          "Message dispatch started",
        );
        try {
          const result = await dispatchEvent({
            definition: messageReceivedEvent,
            event: normalized.event,
            eventBus: required(this.#eventBus, "event bus"),
            engine: required(this.#engine, "workflow engine"),
            workflow: required(this.#messageWorkflow, "message workflow"),
            context: normalized.context({
              database: required(this.#database, "database"),
              eventBus: required(this.#eventBus, "event bus"),
              promptCompiler: required(this.#promptCompiler, "prompt compiler"),
              llmClient: required(this.#llmClient, "LLM client"),
            }),
          });
          const delivery = deliveryReceipt(result);
          const completedNodeIds = result?.completedNodeIds ?? [];
          const durationMs = Math.max(0, this.#now().getTime() - startedAt);
          this.#runtimeLogger?.info(
            {
              event: "message.dispatch.completed",
              sourceKind: input.kind,
              durationMs,
              completedNodeCount: completedNodeIds.length,
              interrupted: result === undefined,
              ...(delivery === undefined ? {} : { deliveryOk: delivery.ok }),
              ...platformLogFields(input),
            },
            "Message dispatch completed",
          );
          if (delivery?.ok === true) {
            this.#runtimeLogger?.info(
              {
                event: "platform.delivery.completed",
                adapterId: delivery.adapterId,
                platform: delivery.platform,
                targetKind: delivery.target.kind,
              },
              "Platform reply delivered",
            );
          } else if (delivery?.ok === false) {
            this.#runtimeLogger?.warn(
              {
                event: "platform.delivery.failed",
                adapterId: delivery.adapterId,
                platform: delivery.platform,
                targetKind: delivery.target.kind,
              },
              "Platform reply delivery failed",
            );
          }
          return {
            traceId: normalized.traceId,
            workflowId: result?.workflowId ?? "message-workflow",
            completedNodeIds,
            ...(delivery === undefined ? {} : { delivery }),
            interrupted: result === undefined,
          };
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
      },
    );
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

function normalizeInboundMessage(
  input: RuntimeInboundMessage,
  now: () => Date,
): {
  traceId: string;
  sessionId: string;
  event: EventEnvelope<"message.received", { text: string }>;
  context: (shared: {
    database: KaguyaDatabase;
    eventBus: EventBus;
    promptCompiler: PromptCompiler;
    llmClient: LlmLifecycleClient;
  }) => WorkflowContext;
} {
  const traceId =
    input.kind === "web" ? `webui-${input.requestId}` : input.message.traceId;
  const sessionId =
    input.kind === "web" ? input.sessionId : input.message.sessionId;
  const occurredAt =
    input.kind === "web"
      ? (input.occurredAt ?? now().toISOString())
      : input.message.occurredAt;
  const nextId = createTraceScopedIdFactory(traceId);
  const metadata =
    input.kind === "web"
      ? { requestId: input.requestId }
      : platformEventMetadata(input.message);
  const event = messageReceivedEvent.create(
    {
      id: `${traceId}-message-received`,
      source:
        input.kind === "web" ? "webui" : `adapter:${input.message.adapterId}`,
      occurredAt,
      traceId,
      sessionId,
      metadata,
    },
    { text: input.kind === "web" ? input.text : input.message.text },
  );

  return {
    traceId,
    sessionId,
    event,
    context(shared): WorkflowContext {
      const services: WorkflowServices = {
        ...shared,
        messageReceivedEvent: event,
        ...(input.kind === "platform"
          ? { platformReplySender: input.replySender }
          : {}),
      };
      return { traceId, sessionId, now, nextId, services };
    },
  };
}

function platformEventMetadata(
  message: PlatformInboundMessage,
): Record<string, unknown> {
  return {
    adapterId: message.adapterId,
    platform: message.platform,
    platformMessageId: message.platformMessageId,
    ...(message.selfId === undefined ? {} : { selfId: message.selfId }),
    target: message.target,
    sender: message.sender,
  };
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

function deliveryReceipt(
  result: WorkflowExecutionResult | undefined,
): PlatformDeliveryReceipt | undefined {
  const value = result?.outputs["send-reply"];
  return typeof value === "object" && value !== null && "ok" in value
    ? (value as PlatformDeliveryReceipt)
    : undefined;
}

function createTraceScopedIdFactory(
  traceId: string,
): (prefix: string) => string {
  let sequence = 0;
  return (prefix) =>
    `${traceId}-${prefix}-${String(++sequence).padStart(6, "0")}`;
}

function createDeterministicModelResolver(): KaguyaLlmModelResolver {
  const models = {
    route: createRepeatingDeterministicModel({
      shouldReply: true,
      reason: "the message should enter the workflow",
    }),
    reply: createRepeatingDeterministicModel({
      text: "It is a lovely night for watching the moon.",
    }),
    state: createRepeatingDeterministicModel({
      mood: "calm",
      relationship: "friendly",
      shortTermMemories: [],
    }),
    memory: createRepeatingDeterministicModel({ memories: [] }),
  };
  return (request) => models[request.kind];
}

function createLoggingRecorder(
  recorder: WorkflowRunRecorder,
  logger: KaguyaLogger | undefined,
): WorkflowRunRecorder {
  return {
    async record(run: EventRun) {
      await recorder.record(run);
      runWithLogContext(
        {
          runId: run.id,
          workflowId: run.workflowId,
          nodeId: run.nodeId,
        },
        () => {
          logger?.debug(
            {
              event: `workflow.node.${run.status}`,
              ...(!("completedAt" in run)
                ? {}
                : {
                    durationMs: Math.max(
                      0,
                      Date.parse(run.completedAt) - Date.parse(run.startedAt),
                    ),
                  }),
              ...(run.status === "failed" ? { retryable: run.retryable } : {}),
            },
            `Workflow node ${run.status}`,
          );
        },
      );
    },
  };
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
