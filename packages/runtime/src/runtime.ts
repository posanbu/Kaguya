/**
 * 功能概述：以 PostgreSQL information ledger 为唯一事实源组合 `KaguyaRuntime`，把外部消息
 * 注册为 context/inbound 原子，并由实时模块广播继续 LLM、assistant 与 delivery DAG。
 * 主要职责：`KaguyaRuntime` 实现窄 `InformationIngress.submit`、transport 注册、异步 start/close；
 * 启动时注册内建与模块 kind、启动 Core/ModuleHost、安装 `runtime:delivery` 系统消费者；
 * 内部 executor 将模块 tier 解析为无持久化 client，再交给原子 lifecycle。
 * 代码库关系：依赖 `PostgresKaguyaDatabase`、Engine InformationCore/ModuleHost、modules 拥有的
 * kind/模块工厂和 Runtime 自有 lifecycle/result kind；Task 5 的 Gateway/adapter 只需持有 ingress。
 * 输入输出与副作用：submit 返回 context 根 `informationId` 与本次调用实际收到的安全 receipt；
 * 不生成 trace/message/event ID，不写旧 SQLite repositories。关闭先停止 ingress、等待 in-flight，
 * 再停模块/Core；仅关闭由 databaseUrl 创建的连接，注入测试数据库仍归调用方所有。
 */
import { randomUUID } from "node:crypto";

import {
  InformationLogProjectionRunner,
  PostgresKaguyaDatabase,
} from "@kaguya/database";
import {
  InformationCore,
  InformationKindRegistry,
  InformationModuleHost,
  consumerFailedInformationKind,
} from "@kaguya/engine";
import {
  KaguyaLlmClient,
  type KaguyaLlmModelResolver,
} from "@kaguya/llm/client";
import { createRepeatingDeterministicModel } from "@kaguya/llm/testing";
import {
  createInformationAtomLogSink,
  createModuleLogger,
  type KaguyaLogger,
} from "@kaguya/logger";
import {
  alwaysReplyInformationFilterModule,
  createLlmInformationReplyModule,
  deliveryRequestedInformationKind,
  inboundTextInformationKind,
  type LlmCompletedInformationPayload as ModuleLlmCompletedInformationPayload,
  type LlmInformationReplyExecutor,
  type ModuleModelSelection,
} from "@kaguya/modules";
import type {
  PlatformDeliveryReceipt,
  PlatformInboundMessage,
  PlatformOutboundTransport,
} from "@kaguya/platform-adapters";
import type {
  DeepReadonly,
  InformationAtom,
  InformationId,
  OutboundMessageContent,
  PlatformDestination,
} from "@kaguya/schema";
import type {
  InformationKindDefinition,
  InformationModuleActivation,
  InformationModuleDefinition,
} from "@kaguya/sdk";

import {
  builtInInformationKinds,
  deliveryDeliveredInformationKind,
  deliveryFailedInformationKind,
  llmCompletedInformationKind,
  runtimeContextInformationKind,
} from "./information-kinds.js";
import { LlmLifecycleClient } from "./llm-lifecycle.js";

export interface InformationIngress {
  submit(input: PlatformInboundMessage): Promise<RuntimeDispatchResult>;
}

export interface RuntimeDispatchResult {
  readonly rootInformationId: InformationId;
  readonly deliveries: readonly PlatformDeliveryReceipt[];
  readonly delivery?: PlatformDeliveryReceipt;
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

export type InformationIdGenerator = () => string;

type KaguyaRuntimeBaseOptions = {
  readonly logger?: KaguyaLogger;
  readonly now?: () => Date;
  readonly informationIdGenerator?: InformationIdGenerator;
  readonly resolveModelSelection?: RuntimeModelSelectionResolver;
  readonly moduleDefinitions?: readonly InformationModuleDefinition[];
  readonly moduleActivations?: readonly InformationModuleActivation[];
};

export type KaguyaRuntimeOptions = KaguyaRuntimeBaseOptions &
  (
    | {
        readonly databaseUrl: string;
        readonly database?: never;
      }
    | {
        readonly database: PostgresKaguyaDatabase;
        readonly databaseUrl?: never;
      }
  );

/** @deprecated Task 5 adapters call InformationIngress.submit directly. */
export interface RuntimePlatformMessage {
  readonly kind: "platform";
  readonly message: PlatformInboundMessage;
}

/** @deprecated Task 5 adapters call InformationIngress.submit directly. */
export type RuntimeInboundMessage = RuntimePlatformMessage;

export class RuntimeUnavailableError extends Error {
  constructor(message = "Kaguya runtime is not accepting information") {
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

type DeliveryRequestedAtom = DeepReadonly<
  InformationAtom<
    "core.delivery.requested",
    {
      adapterId: string;
      platform: string;
      destination: PlatformDestination;
      message: OutboundMessageContent;
    }
  >
>;

export class KaguyaRuntime implements InformationIngress {
  readonly #now: () => Date;
  readonly #nextInformationId: InformationIdGenerator;
  readonly #resolveModelSelection: RuntimeModelSelectionResolver;
  readonly #transports = new Map<string, RuntimeTransportRegistration>();
  readonly #inFlight = new Set<Promise<RuntimeDispatchResult>>();
  readonly #deliveriesByContext = new Map<
    InformationId,
    PlatformDeliveryReceipt[]
  >();
  readonly #runtimeLogger: KaguyaLogger | undefined;

  #state: RuntimeState = "new";
  #closePromise: Promise<void> | undefined;
  #database: PostgresKaguyaDatabase | undefined;
  #ownsDatabase = false;
  #core: InformationCore | undefined;
  #moduleHost: InformationModuleHost | undefined;
  #unsubscribeDelivery: (() => void) | undefined;

  constructor(private readonly options: KaguyaRuntimeOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#nextInformationId = options.informationIdGenerator ?? randomUUID;
    this.#resolveModelSelection =
      options.resolveModelSelection ??
      createDeterministicModelSelectionResolver();
    this.#runtimeLogger =
      options.logger === undefined
        ? undefined
        : createModuleLogger(options.logger, "runtime");
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

    const database =
      this.options.database ??
      (await PostgresKaguyaDatabase.connect({
        connectionString: this.options.databaseUrl,
      }));
    const ownsDatabase = this.options.database === undefined;
    let core: InformationCore | undefined;
    let moduleHost: InformationModuleHost | undefined;
    try {
      await database.migrate();
      const replyModule = createLlmInformationReplyModule({
        executor: { execute: (input) => this.#executeLlm(input) },
        llmCompletedInformationKind:
          llmCompletedInformationKind as unknown as InformationKindDefinition<
            "core.llm.completed",
            ModuleLlmCompletedInformationPayload
          >,
      });
      const definitions = this.options.moduleDefinitions ?? [
        alwaysReplyInformationFilterModule,
        replyModule,
      ];
      const registry = createRegistry(definitions);
      const allDefinitions = collectDefinitions(definitions);
      const logProjectionRunner = new InformationLogProjectionRunner({
        repository: database.information,
        sink:
          this.options.logger === undefined
            ? async () => undefined
            : createInformationAtomLogSink({
                logger: this.options.logger,
                definitions: allDefinitions,
                emergencyReporter: (failure) => {
                  this.#runtimeLogger?.error(
                    {
                      event: "information.log.failed",
                      errorType: failure.errorType,
                      kind: failure.kind,
                    },
                    "Information log projection failed",
                  );
                },
              }),
        reportFailure: (failure) => {
          this.#runtimeLogger?.error(
            {
              event: "information.log.outbox.failed",
              errorType: failure.errorType,
            },
            "Information log outbox failed",
          );
        },
      });
      core = new InformationCore({
        registry,
        store: database.information,
        nextInformationId: this.#nextInformationId,
        now: this.#now,
        bootstrapReporter: (error) => {
          this.#runtimeLogger?.error(
            {
              event: "information.bootstrap.failed",
              errorType: safeErrorType(error),
            },
            "Information bootstrap operation failed",
          );
        },
        logProjectionRunner,
      });
      await core.start();
      moduleHost = new InformationModuleHost({ core, now: this.#now });
      for (const definition of definitions) moduleHost.register(definition);

      this.#database = database;
      this.#ownsDatabase = ownsDatabase;
      this.#core = core;
      this.#moduleHost = moduleHost;
      await moduleHost.start(
        this.options.moduleActivations ??
          (this.options.moduleDefinitions === undefined
            ? defaultModuleActivations()
            : []),
      );
      this.#unsubscribeDelivery = core.on(
        deliveryRequestedInformationKind,
        { consumerId: "runtime:delivery" },
        (request) => this.#deliver(request),
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
      this.#unsubscribeDelivery?.();
      this.#unsubscribeDelivery = undefined;
      await moduleHost?.stop().catch(() => undefined);
      await core?.close().catch(() => undefined);
      if (ownsDatabase) await database.close().catch(() => undefined);
      this.#database = undefined;
      this.#core = undefined;
      this.#moduleHost = undefined;
      this.#ownsDatabase = false;
      this.#state = "closed";
      throw error;
    }
  }

  submit(input: PlatformInboundMessage): Promise<RuntimeDispatchResult> {
    if (this.#state !== "started") {
      return Promise.reject(new RuntimeUnavailableError());
    }
    const operation = this.#submit(input);
    this.#inFlight.add(operation);
    void operation.then(
      () => this.#inFlight.delete(operation),
      () => this.#inFlight.delete(operation),
    );
    return operation;
  }

  /** @deprecated Task 5 adapters call submit(message). */
  dispatch(input: RuntimeInboundMessage): Promise<RuntimeDispatchResult> {
    return this.submit(input.message);
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    if (this.#state === "closed") return Promise.resolve();

    this.#state = "closing";
    this.#closePromise = (async () => {
      await Promise.allSettled([...this.#inFlight]);
      const failures: unknown[] = [];
      try {
        await this.#moduleHost?.stop();
      } catch (error) {
        failures.push(error);
      }
      this.#unsubscribeDelivery?.();
      this.#unsubscribeDelivery = undefined;
      try {
        await this.#core?.close();
      } catch (error) {
        failures.push(error);
      }
      if (this.#ownsDatabase) {
        try {
          await this.#database?.close();
        } catch (error) {
          failures.push(error);
        }
      }
      this.#database = undefined;
      this.#core = undefined;
      this.#moduleHost = undefined;
      this.#ownsDatabase = false;
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

  async #executeLlm(
    input: Parameters<LlmInformationReplyExecutor["execute"]>[0],
  ): ReturnType<LlmInformationReplyExecutor["execute"]> {
    const core = required(this.#core, "information core");
    const contextReference = uniqueContextReference(input.reply);
    const context = await core.get(contextReference.informationId);
    if (context?.kind !== runtimeContextInformationKind.kind) {
      throw new Error("Reply context information is unavailable");
    }
    const resolved = this.#resolveModelSelection(input.selection);
    const lifecycle = new LlmLifecycleClient({
      core,
      client: new KaguyaLlmClient({ model: resolved.model, now: this.#now }),
      now: this.#now,
    });
    return lifecycle.generate(
      {
        kind: "reply",
        modelId: resolved.modelId,
        workflowId: "message-module-pipeline",
        nodeId: "reply.information",
        prompt: {
          kind: "reply",
          text: input.reply.payload.text,
          fragments: [],
          provenance: [],
        },
        reply: input.reply.payload,
      },
      context as DeepReadonly<InformationAtom<"core.runtime.context">>,
      input.reply,
    );
  }

  async #submit(input: PlatformInboundMessage): Promise<RuntimeDispatchResult> {
    const core = required(this.#core, "information core");
    const context = await core.register(runtimeContextInformationKind, {
      occurredAt: input.occurredAt,
      source: "runtime:ingress",
      payload: {},
      references: [],
    });
    const receipts: PlatformDeliveryReceipt[] = [];
    this.#deliveriesByContext.set(context.informationId, receipts);
    try {
      await core.register(inboundTextInformationKind, {
        occurredAt: input.occurredAt,
        source: "runtime:ingress",
        payload: {
          text: input.text,
          source: {
            adapterId: input.adapterId,
            platform: input.platform,
            platformMessageId: input.platformMessageId,
            destination: input.target,
            senderId: input.sender.userId,
          },
        },
        references: [
          {
            relation: "core:context",
            informationId: context.informationId,
          },
        ],
      });
      const deliveries = Object.freeze([...receipts]);
      const delivery = deliveries.at(-1);
      return {
        rootInformationId: context.informationId,
        deliveries,
        ...(delivery === undefined ? {} : { delivery }),
      };
    } finally {
      this.#deliveriesByContext.delete(context.informationId);
    }
  }

  async #deliver(request: DeliveryRequestedAtom): Promise<void> {
    const context = uniqueContextReference(request);
    const registration = this.#transports.get(
      transportKey(request.payload.adapterId, request.payload.platform),
    );
    if (registration === undefined) {
      const error = new OutboundTransportNotFoundError(
        request.payload.adapterId,
        request.payload.platform,
      );
      await this.#registerDeliveryFailure(
        request,
        context.informationId,
        "Outbound transport is not registered",
      );
      throw error;
    }

    let receipt: PlatformDeliveryReceipt;
    try {
      receipt = await registration.transport.sendMessage(
        request.payload.destination,
        request.payload.message,
        { rootInformationId: context.informationId },
      );
    } catch (cause) {
      await this.#registerDeliveryFailure(
        request,
        context.informationId,
        "Platform transport failed",
      );
      throw new OutboundTransportError(
        request.payload.adapterId,
        request.payload.platform,
        cause,
      );
    }

    const core = required(this.#core, "information core");
    if (receipt.ok) {
      await core.register(deliveryDeliveredInformationKind, {
        occurredAt: this.#now().toISOString(),
        source: "runtime:delivery",
        payload: safeDeliveredPayload(receipt),
        references: deliveryResultReferences(
          request.informationId,
          context.informationId,
        ),
      });
    } else {
      await core.register(deliveryFailedInformationKind, {
        occurredAt: this.#now().toISOString(),
        source: "runtime:delivery",
        payload: safeFailedDeliveryPayload(receipt),
        references: deliveryResultReferences(
          request.informationId,
          context.informationId,
        ),
      });
    }
    this.#deliveriesByContext
      .get(context.informationId)
      ?.push(safeRuntimeReceipt(receipt));
  }

  async #registerDeliveryFailure(
    request: DeliveryRequestedAtom,
    contextInformationId: InformationId,
    error: string,
  ): Promise<void> {
    await required(this.#core, "information core").register(
      deliveryFailedInformationKind,
      {
        occurredAt: this.#now().toISOString(),
        source: "runtime:delivery",
        payload: {
          ok: false,
          adapterId: request.payload.adapterId,
          platform: request.payload.platform,
          target: request.payload.destination,
          error,
        },
        references: deliveryResultReferences(
          request.informationId,
          contextInformationId,
        ),
      },
    );
  }
}

function createRegistry(
  moduleDefinitions: readonly InformationModuleDefinition[],
): InformationKindRegistry {
  const registry = new InformationKindRegistry();
  const registered = new Map<string, InformationKindDefinition<string, any>>();
  for (const definition of builtInInformationKinds) {
    registered.set(definition.kind, definition);
    if (definition === consumerFailedInformationKind) continue;
    if (definition.kind.startsWith("core."))
      registry.registerBuiltin(definition);
    else registry.register(definition);
  }
  for (const module of moduleDefinitions) {
    for (const definition of module.manifest.informationKinds) {
      const existing = registered.get(definition.kind);
      if (existing !== undefined) {
        if (existing !== definition) {
          throw new Error(
            `Information kind definition mismatch: ${definition.kind}`,
          );
        }
        continue;
      }
      registry.register(definition);
      registered.set(definition.kind, definition);
    }
  }
  return registry;
}

function collectDefinitions(
  moduleDefinitions: readonly InformationModuleDefinition[],
): readonly InformationKindDefinition<string, any>[] {
  const definitions = new Map<string, InformationKindDefinition<string, any>>(
    builtInInformationKinds.map((definition) => [definition.kind, definition]),
  );
  for (const module of moduleDefinitions) {
    for (const definition of module.manifest.informationKinds) {
      definitions.set(definition.kind, definition);
    }
  }
  return [...definitions.values()];
}

function defaultModuleActivations(): readonly InformationModuleActivation[] {
  return [
    {
      instanceId: "filter.default",
      definitionId: "demo.filter.always-information",
      settings: {},
    },
    {
      instanceId: "reply.default",
      definitionId: "demo.reply.llm-information",
      settings: {
        modelTier: "heavy",
        outbound: { mode: "source", messageKind: "reply" },
      },
    },
  ];
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

function uniqueContextReference(atom: DeepReadonly<InformationAtom>): {
  readonly relation: "core:context";
  readonly informationId: InformationId;
} {
  const contexts = atom.references.filter(
    ({ relation }) => relation === "core:context",
  );
  if (contexts.length !== 1) {
    throw new Error(`Information atom must have one context: ${atom.kind}`);
  }
  return {
    relation: "core:context",
    informationId: contexts[0]!.informationId,
  };
}

function deliveryResultReferences(
  requestInformationId: InformationId,
  contextInformationId: InformationId,
) {
  return [
    { relation: "core:caused-by", informationId: requestInformationId },
    { relation: "core:status-of", informationId: requestInformationId },
    { relation: "core:context", informationId: contextInformationId },
  ];
}

function safeDeliveredPayload(receipt: PlatformDeliveryReceipt) {
  return {
    ok: true as const,
    adapterId: receipt.adapterId,
    platform: receipt.platform,
    target: receipt.target,
    ...(receipt.platformMessageId === undefined
      ? {}
      : { platformMessageId: receipt.platformMessageId }),
  };
}

function safeFailedDeliveryPayload(receipt: PlatformDeliveryReceipt) {
  return {
    ok: false as const,
    adapterId: receipt.adapterId,
    platform: receipt.platform,
    target: receipt.target,
    error: "Platform delivery failed",
  };
}

function safeRuntimeReceipt(
  receipt: PlatformDeliveryReceipt,
): PlatformDeliveryReceipt {
  return {
    ok: receipt.ok,
    adapterId: receipt.adapterId,
    platform: receipt.platform,
    target: receipt.target,
    ...(receipt.platformMessageId === undefined
      ? {}
      : { platformMessageId: receipt.platformMessageId }),
    ...(receipt.error === undefined ? {} : { error: receipt.error }),
  };
}

function transportKey(adapterId: string, platform: string): string {
  return `${platform}:${adapterId}`;
}

function safeErrorType(error: unknown): string {
  return error instanceof Error && error.name.length > 0
    ? error.name.slice(0, 128)
    : "UnknownError";
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new RuntimeUnavailableError(`${label} is not initialized`);
  }
  return value;
}
