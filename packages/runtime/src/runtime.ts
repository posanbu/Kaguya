/**
 * 功能概述：以 PostgreSQL information ledger 为唯一事实源组合 `KaguyaRuntime`，把外部消息
 * 注册为 context/inbound 原子，并由实时模块广播继续 LLM、assistant 与 delivery DAG。
 * 主要职责：`KaguyaRuntime` 实现窄 `InformationIngress.submit`、transport 注册、串行化 start/close；
 * 启动时注册内建与模块 kind、启动 Core/ModuleHost、安装 `runtime:delivery` 系统消费者；
 * 内部 executor 将模块 tier 解析为无持久化 client，再交给原子 lifecycle。
 * 代码库关系：依赖 `KaguyaDatabase`、Engine InformationCore/ModuleHost、modules 拥有的
 * kind/模块工厂和 Runtime 自有 lifecycle/result kind；Task 5 的 Gateway/adapter 只需持有 ingress。
 * 输入输出与副作用：submit 返回 context 根 `informationId` 与本次调用实际收到的安全 receipt；
 * 不生成 trace/message/event ID，不写旧 SQLite repositories。starting 期间的 close 会先等待或
 * 取消共享启动任务，再执行一次资源清理；仅关闭由 databaseUrl 创建的连接，注入数据库归调用方。
 */
import { randomUUID } from "node:crypto";

import {
  InformationLogProjectionRunner,
  KaguyaDatabase,
} from "@kaguya/database";
import {
  InformationCore,
  InformationKindRegistry,
  ModuleHost,
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
  alwaysReplyFilterModule,
  createLlmReplyModule,
  deliveryRequestedInformationKind,
  inboundTextInformationKind,
  type LlmCompletedInformationPayload as ModuleLlmCompletedInformationPayload,
  type LlmReplyExecutor,
  type ModuleModelSelection,
} from "@kaguya/modules";
import type {
  InboundReceipt,
  InformationIngress,
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
        readonly database: KaguyaDatabase;
        readonly databaseUrl?: never;
      }
  );

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

type RuntimeState = "new" | "starting" | "started" | "closing" | "closed";

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
  readonly #inFlight = new Set<Promise<InboundReceipt>>();
  readonly #deliveriesByContext = new Map<
    InformationId,
    PlatformDeliveryReceipt[]
  >();
  readonly #runtimeLogger: KaguyaLogger | undefined;

  #state: RuntimeState = "new";
  #startPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #cleanupPromise: Promise<unknown[]> | undefined;
  #database: KaguyaDatabase | undefined;
  #ownsDatabase = false;
  #core: InformationCore | undefined;
  #moduleHost: ModuleHost | undefined;
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

  start(): Promise<void> {
    if (this.#state === "starting") {
      return required(this.#startPromise, "runtime start");
    }
    if (this.#state === "started") return Promise.resolve();
    if (this.#state !== "new") {
      return Promise.reject(
        new RuntimeUnavailableError("Kaguya runtime cannot be restarted"),
      );
    }

    this.#state = "starting";
    this.#startPromise = this.#startRuntime();
    return this.#startPromise;
  }

  async #startRuntime(): Promise<void> {
    try {
      const database =
        this.options.database ??
        (await KaguyaDatabase.connect({
          connectionString: this.options.databaseUrl,
        }));
      this.#database = database;
      this.#ownsDatabase = this.options.database === undefined;
      this.#assertStarting();
      await database.migrate();
      this.#assertStarting();
      const replyModule = createLlmReplyModule({
        executor: { execute: (input) => this.#executeLlm(input) },
        llmCompletedInformationKind:
          llmCompletedInformationKind as unknown as InformationKindDefinition<
            "core.llm.completed",
            ModuleLlmCompletedInformationPayload
          >,
      });
      const definitions = this.options.moduleDefinitions ?? [
        alwaysReplyFilterModule,
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
      const core = new InformationCore({
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
      this.#core = core;
      await core.start();
      this.#assertStarting();
      const moduleHost = new ModuleHost({ core, now: this.#now });
      this.#moduleHost = moduleHost;
      for (const definition of definitions) moduleHost.register(definition);

      await moduleHost.start(
        this.options.moduleActivations ??
          (this.options.moduleDefinitions === undefined
            ? defaultModuleActivations()
            : []),
      );
      this.#assertStarting();
      this.#unsubscribeDelivery = core.on(
        deliveryRequestedInformationKind,
        { consumerId: "runtime:delivery" },
        (request) => this.#deliver(request),
      );
      this.#assertStarting();
      this.#state = "started";
      this.#runtimeLogger?.info(
        {
          event: "runtime.started",
          transportCount: this.#transports.size,
        },
        "Kaguya runtime started",
      );
    } catch (error) {
      if (this.#state !== "closing") {
        this.#state = "closing";
        await this.#cleanupResources();
        this.#state = "closed";
      }
      throw error;
    }
  }

  submit(input: PlatformInboundMessage): Promise<InboundReceipt> {
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

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    if (this.#state === "closed") return Promise.resolve();

    const starting =
      this.#state === "starting" ? this.#startPromise : undefined;
    this.#state = "closing";
    this.#closePromise = (async () => {
      await starting?.catch(() => undefined);
      await Promise.allSettled([...this.#inFlight]);
      const failures = await this.#cleanupResources();
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

  #cleanupResources(): Promise<unknown[]> {
    if (this.#cleanupPromise !== undefined) return this.#cleanupPromise;
    this.#cleanupPromise = (async () => {
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
      return failures;
    })();
    return this.#cleanupPromise;
  }

  #assertStarting(): void {
    if (this.#state !== "starting") {
      throw new RuntimeUnavailableError("Kaguya runtime start was cancelled");
    }
  }

  async #executeLlm(
    input: Parameters<LlmReplyExecutor["execute"]>[0],
  ): ReturnType<LlmReplyExecutor["execute"]> {
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
        nodeId: "reply",
        originatingModuleInstanceId: input.originatingModuleInstanceId,
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

  async #submit(input: PlatformInboundMessage): Promise<InboundReceipt> {
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
      definitionId: "demo.filter.always",
      settings: {},
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
