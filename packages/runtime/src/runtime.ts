/**
 * 功能概述：以 PostgreSQL information ledger 装配通用 Runtime，接受显式 Catalog、activations 和宿主 capabilities。
 * 主要职责：start 注册完整 kind 并预检模块，最后开放 ingress；submit 持久化 context/inbound 后返回接受凭据；
 * 平台投递使用 durable subscription，终态唯一槽避免重放再次落账，已有终态时不重复调用 transport。
 * 代码库关系：依赖 Database、Core、ModuleHost 和平台适配契约；具体 Agent 列表与 LLM 模型绑定位于 apps composition root。
 * 输入输出与副作用：连接、迁移、账本写入和 transport I/O 均在生命周期内执行；close 拒绝新入口并停止可靠领取。
 * 数据库初始化错误脱敏；只关闭自行创建的连接。submit 的 deliveries 是当次实际收集快照，可靠链通常异步完成。
 * Model Task 由 composeModelTaskCapabilities 注入批准的 ModelTaskClient；ApprovedModelTaskClient
 * 校验宿主 activation/tier 白名单，provider、resolver、Core 与 approval 数据均保存在私有字段，
 * 模块只通过 #76 的 context.use 获得通用能力。缺少批准或无效 capability 在任何 create 前拒绝。
 * Memory association 默认使用独立 Memory 仓储的 sparse Selector strategy；调用方传入空
 * `retrievalStrategies` 可显式禁用它，模块随后只记录 unavailable terminal。
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
  type InformationRetrievalStrategy,
} from "@kaguya/engine";
import {
  createInformationAtomLogSink,
  createModuleLogger,
  type KaguyaLogger,
} from "@kaguya/logger";
import { memoryCapability } from "@kaguya/memory";
import {
  deliveryRequestedInformationKind,
  inboundTextInformationKind,
} from "@kaguya/modules";
import {
  CadenceCoordinator,
  cadenceInformationKinds,
  installProjectionReconciliationConsumers,
  type CadenceDefinitionInput,
  DurableOneShotScheduler,
  OneShotScheduleClient,
  oneShotInformationKinds,
  type OneShotScheduleCapability,
} from "@kaguya/scheduler";
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
import { defineInformationSelector } from "@kaguya/sdk";
import type {
  InformationKindDefinition,
  InformationModuleActivation,
  InformationModuleDefinition,
  InformationModuleCatalog,
  ModuleCapabilityImplementation,
  ModuleActivationProvenance,
} from "@kaguya/sdk";
import {
  ModelTaskClient,
  modelTaskCapability,
  type ModelTaskClientOptions,
  type ModelTaskRequest,
} from "./model-task.js";
import { MemoryInformationRetrievalStrategy } from "./memory-retrieval.js";

import {
  builtInInformationKinds,
  deliveryDeliveredInformationKind,
  deliveryFailedInformationKind,
  runtimeContextInformationKind,
  modelTaskSelectionPolicySchema,
  modelTaskInformationKinds,
} from "./information-kinds.js";

export interface RuntimeModelTaskApproval {
  readonly activation: ModuleActivationProvenance;
  readonly selectionPolicy: ModelTaskRequest<unknown>["selectionPolicy"];
}
export type RuntimeModelTaskOptions = Pick<
  ModelTaskClientOptions,
  "client" | "resolveModel"
> & {
  readonly approvals: readonly RuntimeModelTaskApproval[];
};

export interface RuntimeCapabilityContext {
  readonly core: InformationCore;
  readonly now: () => Date;
  readonly oneShotSchedule: OneShotScheduleCapability;
}
export type RuntimeCapabilities =
  | readonly ModuleCapabilityImplementation[]
  | ((
      context: RuntimeCapabilityContext,
    ) => readonly ModuleCapabilityImplementation[]);

export interface RuntimeTransportRegistration {
  readonly adapterId: string;
  readonly platform: string;
  readonly transport: PlatformOutboundTransport;
}

export type InformationIdGenerator = () => string;

type KaguyaRuntimeBaseOptions = {
  /** 每个关闭阶段等待未完成工作的上限，默认 5000 毫秒。 */
  readonly drainTimeoutMs?: number;
  readonly logger?: KaguyaLogger;
  readonly now?: () => Date;
  readonly informationIdGenerator?: InformationIdGenerator;
  readonly catalog: InformationModuleCatalog;
  readonly activations: readonly InformationModuleActivation[];
  readonly capabilities?: RuntimeCapabilities;
  readonly retrievalStrategies?: readonly InformationRetrievalStrategy[];
  readonly modelTask?: RuntimeModelTaskOptions;
  readonly cadence?: {
    readonly definitions: readonly CadenceDefinitionInput[];
    readonly pollIntervalMs?: number;
    readonly reconciliationBatchSize?: number;
  };
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

export class RuntimeDatabaseInitializationError extends Error {
  readonly failureType: string;

  constructor(error: unknown) {
    super("Runtime database initialization failed");
    this.name = "RuntimeDatabaseInitializationError";
    this.failureType = safeErrorType(error);
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
  readonly #transports = new Map<string, RuntimeTransportRegistration>();
  readonly #inFlight = new Set<Promise<InboundReceipt>>();
  readonly #deliveriesByContext = new Map<
    InformationId,
    PlatformDeliveryReceipt[]
  >();
  readonly #runtimeLogger: KaguyaLogger | undefined;
  readonly #oneShotRecoveryGate: Promise<void> | undefined;

  #state: RuntimeState = "new";
  #startPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #cleanupPromise: Promise<unknown[]> | undefined;
  #database: KaguyaDatabase | undefined;
  #ownsDatabase = false;
  #core: InformationCore | undefined;
  #moduleHost: ModuleHost | undefined;
  #cadence: CadenceCoordinator | undefined;
  #cadenceUnsubscribe: readonly (() => void)[] = [];
  #oneShotSchedule: OneShotScheduleCapability | undefined;
  #oneShotScheduler: DurableOneShotScheduler | undefined;
  #oneShotRecoveryPromise: Promise<void> | undefined;
  #oneShotSchedulerReady = false;
  readonly #oneShotPendingRefresh = new Set<InformationId>();

  constructor(private readonly options: KaguyaRuntimeOptions) {
    if (
      !Number.isFinite(options.drainTimeoutMs ?? 5000) ||
      (options.drainTimeoutMs ?? 5000) < 0
    ) {
      throw new Error("Runtime drain timeout must be finite and non-negative");
    }
    this.#now = options.now ?? (() => new Date());
    this.#nextInformationId = options.informationIdGenerator ?? randomUUID;
    this.#oneShotRecoveryGate = (
      options as { oneShotRecoveryGate?: Promise<void> }
    ).oneShotRecoveryGate;
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
      try {
        await database.migrate();
      } catch (error) {
        throw new RuntimeDatabaseInitializationError(error);
      }
      this.#assertStarting();
      const definitions = this.options.catalog.definitions;
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
        drainTimeoutMs: this.options.drainTimeoutMs ?? 5000,
        registry,
        store: database.information,
        nextInformationId: this.#nextInformationId,
        now: this.#now,
        retrievalStrategies: this.options.retrievalStrategies ?? [
          new MemoryInformationRetrievalStrategy(database.memory, {
            reportFailure: ({ errorType }) => {
              this.#runtimeLogger?.error(
                { event: "memory.recall.failed", errorType },
                "Memory recall failed",
              );
            },
          }),
        ],
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
      if (this.options.cadence !== undefined) {
        this.#cadenceUnsubscribe = installProjectionReconciliationConsumers(
          core,
          logProjectionRunner,
          this.options.cadence.reconciliationBatchSize,
        );
      }
      const scheduler = new DurableOneShotScheduler({
        store: database.information.oneShotSchedules,
        clock: {
          now: this.#now,
          setTimeout: globalThis.setTimeout.bind(globalThis),
          clearTimeout: globalThis.clearTimeout.bind(globalThis),
        },
        nextInformationId: this.#nextInformationId,
        drainTimeoutMs: this.options.drainTimeoutMs ?? 5000,
      });
      this.#oneShotScheduler = scheduler;
      const client = new OneShotScheduleClient(core);
      const oneShotSchedule: OneShotScheduleCapability = {
        schedule: async (input) => {
          const receipt = await client.schedule(input);
          if (this.#oneShotSchedulerReady) {
            await scheduler.refresh(receipt.scheduleInformationId);
          } else this.#oneShotPendingRefresh.add(receipt.scheduleInformationId);
          return receipt;
        },
        replace: async (input) => {
          const receipt = await client.replace(input);
          if (this.#oneShotSchedulerReady) {
            await scheduler.refresh(receipt.scheduleInformationId);
          } else this.#oneShotPendingRefresh.add(receipt.scheduleInformationId);
          return receipt;
        },
        finish: (input) => client.finish(input),
      };
      this.#oneShotSchedule = oneShotSchedule;
      const suppliedCapabilities =
        typeof this.options.capabilities === "function"
          ? this.options.capabilities({
              core,
              now: this.#now,
              oneShotSchedule,
            })
          : this.options.capabilities;
      const capabilities = [
        { capability: memoryCapability, value: database.memory },
        ...composeModelTaskCapabilities(
          this.options,
          { core, now: this.#now, oneShotSchedule },
          suppliedCapabilities ?? [],
        ),
      ];
      const moduleHost = new ModuleHost({
        drainTimeoutMs: this.options.drainTimeoutMs ?? 5000,
        core,
        catalog: this.options.catalog,
        capabilities,
        now: this.#now,
      });
      this.#moduleHost = moduleHost;
      core.onDurable(
        "kaguya.runtime.delivery",
        deliveryRequestedInformationKind,
        (request) => this.#deliver(request),
      );
      await moduleHost.start(this.options.activations);
      this.#assertStarting();
      if (this.options.cadence !== undefined) {
        this.#cadence = new CadenceCoordinator({
          core,
          definitions: this.options.cadence.definitions,
          now: this.#now,
          ...(this.options.cadence.pollIntervalMs === undefined
            ? {}
            : { pollIntervalMs: this.options.cadence.pollIntervalMs }),
          onError: (error) => {
            this.#runtimeLogger?.error(
              {
                event: "scheduler.cadence.failed",
                errorType: safeErrorType(error),
              },
              "Cadence coordinator failed",
            );
          },
        });
        await this.#cadence.start();
      }
      this.#oneShotRecoveryPromise = this.#oneShotRecoveryGate;
      await scheduler.start();
      await this.#oneShotRecoveryPromise;
      this.#oneShotSchedulerReady = true;
      for (const scheduleInformationId of this.#oneShotPendingRefresh) {
        await scheduler.refresh(scheduleInformationId);
      }
      this.#oneShotPendingRefresh.clear();
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
      if (this.#state === "closing")
        throw new RuntimeUnavailableError("Kaguya runtime start was cancelled");
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
    // create/start 可以正在等待 activation signal；必须在等待启动任务之前传播取消。
    void this.#oneShotScheduler?.stop().catch(() => undefined);
    void this.#moduleHost?.stop().catch(() => undefined);
    this.#closePromise = (async () => {
      await starting?.catch(() => undefined);
      await drainRuntimeOperations(
        [...this.#inFlight],
        this.options.drainTimeoutMs ?? 5000,
      );
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
        await this.#oneShotScheduler?.stop();
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.#cadence?.stop();
      } catch (error) {
        failures.push(error);
      }
      for (const unsubscribe of this.#cadenceUnsubscribe) unsubscribe();
      this.#cadenceUnsubscribe = [];
      this.#cadence = undefined;
      try {
        await this.#moduleHost?.stop();
      } catch (error) {
        failures.push(error);
      }
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
      this.#oneShotSchedule = undefined;
      this.#oneShotScheduler = undefined;
      this.#oneShotRecoveryPromise = undefined;
      this.#oneShotSchedulerReady = false;
      this.#oneShotPendingRefresh.clear();
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
            sender: {
              userId: input.sender.userId,
              ...(input.sender.nickname
                ? { nickname: input.sender.nickname }
                : {}),
              ...(input.sender.card ? { card: input.sender.card } : {}),
              ...(input.selfId
                ? { isSelf: input.sender.userId === input.selfId }
                : {}),
            },
            ...(input.selfId ? { selfId: input.selfId } : {}),
            mentions: [...input.mentions],
            ...(input.replyTo ? { replyTo: { ...input.replyTo } } : {}),
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
      return {
        rootInformationId: context.informationId,
        deliveries,
      };
    } finally {
      this.#deliveriesByContext.delete(context.informationId);
    }
  }

  async #deliver(request: DeliveryRequestedAtom): Promise<void> {
    const core = required(this.#core, "information core");
    if (
      (await core.select(deliveryTerminalSelector, request.informationId))
        .length > 0
    )
      return;
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

    if (receipt.ok) {
      await core.commitTerminal(
        "kaguya.delivery.result.v1",
        request.informationId,
        deliveryDeliveredInformationKind,
        {
          occurredAt: this.#now().toISOString(),
          source: "runtime:delivery",
          payload: safeDeliveredPayload(receipt),
          references: deliveryResultReferences(
            request.informationId,
            context.informationId,
          ),
        },
      );
    } else {
      await core.commitTerminal(
        "kaguya.delivery.result.v1",
        request.informationId,
        deliveryFailedInformationKind,
        {
          occurredAt: this.#now().toISOString(),
          source: "runtime:delivery",
          payload: safeFailedDeliveryPayload(receipt),
          references: deliveryResultReferences(
            request.informationId,
            context.informationId,
          ),
        },
      );
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
    await required(this.#core, "information core").commitTerminal(
      "kaguya.delivery.result.v1",
      request.informationId,
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

class ApprovedModelTaskClient extends ModelTaskClient {
  readonly #approvals: readonly RuntimeModelTaskApproval[];
  constructor(
    options: ModelTaskClientOptions,
    approvals: readonly RuntimeModelTaskApproval[],
  ) {
    super(options);
    this.#approvals = approvals.map(({ activation, selectionPolicy }) => ({
      activation: Object.freeze({ ...activation }),
      selectionPolicy: Object.freeze(
        modelTaskSelectionPolicySchema.parse(selectionPolicy),
      ),
    }));
  }

  override execute<TOutput>(request: ModelTaskRequest<TOutput>) {
    if (
      !this.#approvals.some(
        ({ activation, selectionPolicy }) =>
          activation.instanceId === request.activation.instanceId &&
          activation.definitionId === request.activation.definitionId &&
          selectionPolicy.tier === request.selectionPolicy.tier,
      )
    )
      return Promise.reject(
        new Error("Model task activation or policy is not approved"),
      );
    return super.execute(request);
  }
}

function composeModelTaskCapabilities(
  options: KaguyaRuntimeOptions,
  context: RuntimeCapabilityContext,
  supplied: readonly ModuleCapabilityImplementation[],
): readonly ModuleCapabilityImplementation[] {
  const capabilities = [...supplied];
  if (options.modelTask) {
    const approvals = options.modelTask.approvals.filter(({ activation }) =>
      options.activations.some(
        (a) =>
          a.enabled !== false &&
          a.instanceId === activation.instanceId &&
          a.definitionId === activation.definitionId,
      ),
    );
    for (const activation of options.activations) {
      if (activation.enabled === false) continue;
      const definition = options.catalog.definitions.find(
        (d) => d.manifest.definitionId === activation.definitionId,
      );
      if (
        definition?.manifest.requires.some(
          (c) => c.id === modelTaskCapability.id,
        ) &&
        !approvals.some(
          (a) =>
            a.activation.instanceId === activation.instanceId &&
            a.activation.definitionId === activation.definitionId,
        )
      )
        throw new Error("Missing model task capability approval");
    }
    capabilities.push({
      capability: modelTaskCapability,
      value: new ApprovedModelTaskClient(
        { ...options.modelTask, ...context },
        approvals,
      ),
    });
  }
  for (const implementation of capabilities) {
    if (implementation.capability.id !== modelTaskCapability.id) continue;
    if (
      implementation.capability.apiVersion !== modelTaskCapability.apiVersion ||
      !(implementation.value instanceof ModelTaskClient)
    )
      throw new Error("Invalid host model task capability");
  }
  for (const activation of options.activations) {
    if (activation.enabled === false) continue;
    const definition = options.catalog.definitions.find(
      (d) => d.manifest.definitionId === activation.definitionId,
    );
    if (
      definition?.manifest.requires.some(
        (c) => c.id === modelTaskCapability.id,
      ) &&
      !capabilities.some((c) => c.capability.id === modelTaskCapability.id)
    )
      throw new Error("Missing host model task capability");
  }
  return capabilities;
}

const deliveryTerminalSelector = defineInformationSelector({
  selectorId: "runtime.delivery.terminal",
  select: async ({ sourceAtom, ledger }) =>
    (
      await ledger.related({
        from: [sourceAtom.informationId],
        relation: "core:status-of",
        direction: "incoming",
        limit: 2,
      })
    )
      .filter(
        (atom) =>
          atom.kind === deliveryDeliveredInformationKind.kind ||
          atom.kind === deliveryFailedInformationKind.kind,
      )
      .map((atom) => atom.informationId),
});

function createRegistry(
  moduleDefinitions: readonly InformationModuleDefinition[],
): InformationKindRegistry {
  const registry = new InformationKindRegistry();
  const registered = new Map<string, InformationKindDefinition<string, any>>();
  for (const definition of [
    ...builtInInformationKinds,
    ...modelTaskInformationKinds,
    ...cadenceInformationKinds,
    ...oneShotInformationKinds,
  ]) {
    registered.set(definition.kind, definition);
    if (definition === consumerFailedInformationKind) continue;
    if (definition.kind.startsWith("core."))
      registry.registerBuiltin(definition);
    else registry.register(definition);
  }
  for (const module of moduleDefinitions) {
    for (const definition of [
      ...module.manifest.consumes,
      ...module.manifest.produces,
    ]) {
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
    [
      ...builtInInformationKinds,
      ...modelTaskInformationKinds,
      ...cadenceInformationKinds,
      ...oneShotInformationKinds,
    ].map((definition) => [definition.kind, definition]),
  );
  for (const module of moduleDefinitions) {
    for (const definition of [
      ...module.manifest.consumes,
      ...module.manifest.produces,
    ]) {
      definitions.set(definition.kind, definition);
    }
  }
  return [...definitions.values()];
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
  try {
    return error instanceof Error ? "Error" : "UnknownError";
  } catch {
    return "UnknownError";
  }
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new RuntimeUnavailableError(`${label} is not initialized`);
  }
  return value;
}

// 入站观察者可能忽略取消；超时后继续清理 Core 与数据库，避免退出被永久阻塞。
async function drainRuntimeOperations(
  pending: readonly Promise<unknown>[],
  timeout: number,
): Promise<void> {
  if (pending.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeout);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
