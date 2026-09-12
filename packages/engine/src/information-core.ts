/**
 * stopReliableDelivery 可选 drain：停止领取后有界等待活跃 claim，再执行 shutdown fencing，支持 Runtime 热切换。
 * 架构说明：本模块把 registry、store 与 bus 组合成信息 Core，
 * 负责启动前注册同步、注册时的 ID 生成、引用 expectations 传递、并发广播与故障事实。
 * 主要职责：`registerOnce`/`commitTerminal` 在数据库原子竞争且只广播新赢家；durable handler 由 claim 与 signal 保护；
 * `register` 用于 ingress 与 live 观测事实，校验、落账并广播新 atom；`on` 校验非空 typed consumer 身份后订阅；
 * `get`/`getMany`/`find`/`query` 只读账本；公开写入和订阅分别只有 `register` 与 typed `on`。
 * 代码库关系：Core 是信息原子体系的入口编排层，依赖 Registry、Ledger 与 Bus；
 * `information-kinds.ts` 提供唯一的 `consumer.failed` 定义，Runtime 后续复用它。
 * 输入输出与副作用：提交成功才广播当前快照，拒绝的消费者被记录为失败 atom；失败
 * atom 的消费者或持久化失败只进入 bootstrap reporter，绝不递归产生故障链；失败事实
 * 会继承输入唯一的 `core:context`，Error rejection 的类型固定为 `Error`。start/close 共享
 * promise；关闭先拒绝新注册、有界等待已接受的落账和广播，再排空日志投影并清理订阅，
 * 确保并发调用不能重复初始化、复活 Core 或泄漏原异常正文。
 */
import {
  ReliableInformationRunner,
  type ReliableInformationSubscription,
} from "./reliable-runner.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { InformationClaim } from "./reliable-types.js";
import { executionExhaustedInformationKind } from "./reliable-kinds.js";
import {
  type DeepReadonly,
  freezeInformationAtom,
  informationAtomSchema,
  informationIdSchema,
  informationReferenceSchema,
  type InformationAtom,
  type InformationId,
  type InformationReference,
  type JsonObject,
} from "@kaguya/schema";
import type {
  InformationFindQuery,
  InformationKindDefinition,
  InformationRegistrationInput,
  InformationReferenceRule,
  InformationSelectorDefinition,
} from "@kaguya/sdk";
import {
  oneShotRequestedInformationKind,
  oneShotDueInformationKind,
  oneShotSupersededInformationKind,
  oneShotFiredInformationKind,
  oneShotFailedInformationKind,
  type OneShotScheduleCorePort,
  type OneShotScheduleRequest,
  type OneShotScheduleReplacement,
  type OneShotTerminalRequest,
  type OneShotScheduleReceipt,
  type OneShotReplacementReceipt,
  type OneShotTerminalResult,
  type OneShotFencingGuard,
} from "@kaguya/scheduler";

import {
  InformationBus,
  type InformationConsumer,
  type InformationSubscriber,
} from "./information-bus.js";
import {
  InformationCoreClosedError,
  InformationCoreNotStartedError,
  InformationIdCollisionError,
  InvalidInformationIdError,
  InformationReferenceValidationError,
} from "./information-errors.js";
import { InformationKindRegistry } from "./information-kind-registry.js";
import { consumerFailedInformationKind } from "./information-kinds.js";
import {
  InformationSelectorExecutor,
  type InformationRetrievalStrategy,
} from "./information-selector.js";

export {
  InformationCoreClosedError,
  InformationCoreNotStartedError,
  InformationIdCollisionError,
  InformationReferenceValidationError,
  InvalidInformationIdError,
} from "./information-errors.js";

export interface InformationReferenceExpectation {
  readonly relation: string;
  readonly required: boolean;
  readonly multiple: boolean;
  readonly targetKinds?: readonly string[];
}

export interface InformationReferenceQuery {
  readonly informationId: InformationId;
  readonly relation?: string;
}

/**
 * Append-only persistence boundary for information atoms.
 *
 * The interface deliberately exposes only append and constrained reads.  It has
 * no update, delete, TTL, or compaction operation: a state change is a new atom.
 */
export interface InformationLedger {
  readonly oneShotSchedules?: import("@kaguya/scheduler").OneShotScheduleProjectionStore;
  readonly reliable?: import("./reliable-types.js").ReliableInformationLedger;
  synchronizeKinds(kinds: readonly string[]): Promise<void>;
  append(
    atom: DeepReadonly<InformationAtom>,
    expectations: readonly InformationReferenceExpectation[],
    options?: InformationAppendOptions,
  ): Promise<void>;
  get(
    informationId: InformationId,
  ): Promise<DeepReadonly<InformationAtom> | undefined>;
  getMany(
    informationIds: readonly InformationId[],
  ): Promise<readonly DeepReadonly<InformationAtom>[]>;
  find(
    query: InformationFindQuery,
  ): Promise<readonly DeepReadonly<InformationAtom>[]>;
  query(
    query: InformationReferenceQuery,
  ): Promise<readonly DeepReadonly<InformationAtom>[]>;
}

export interface InformationAppendOptions {
  /** Queue a durable, post-commit log projection for this atom. */
  readonly enqueueLogProjection?: boolean;
}

/**
 * A post-commit projection runner.  Its implementation must isolate projection
 * failures: a console failure must never undo a committed atom.
 */
export interface InformationLogProjectionRunner {
  projectPending(): Promise<void>;
  drainPending(): Promise<void>;
}

export interface InformationCoreOptions {
  readonly drainTimeoutMs?: number;
  readonly registry: InformationKindRegistry;
  readonly store: InformationLedger;
  readonly nextInformationId: () => string;
  readonly now?: () => Date;
  readonly bootstrapReporter?: (error: unknown) => void | Promise<void>;
  readonly logProjectionRunner?: InformationLogProjectionRunner;
  readonly retrievalStrategies?: readonly InformationRetrievalStrategy[];
}

type UniqueCommit =
  | {
      type: "operation" | "terminal";
      namespace: string;
      key: string;
      guard?: InformationClaim;
    }
  | { type: "exhaust"; claim: InformationClaim };

type CoreState = "new" | "starting" | "started" | "closing" | "closed";

export class InformationCore implements OneShotScheduleCorePort {
  readonly #durableSubscriptions = new Map<
    string,
    ReliableInformationSubscription
  >();
  #reliableRunner: ReliableInformationRunner | undefined;
  readonly #execution = new AsyncLocalStorage<{
    claim: InformationClaim;
    signal: AbortSignal;
  }>();
  readonly registry: InformationKindRegistry;
  readonly store: InformationLedger;
  #bus: InformationBus;
  #nextInformationId: () => string;
  #now: () => Date;
  #bootstrapReporter: (error: unknown) => void | Promise<void>;
  #logProjectionRunner: InformationLogProjectionRunner | undefined;
  #selectorExecutor: InformationSelectorExecutor;
  readonly #drainTimeoutMs: number;
  #state: CoreState = "new";
  #startPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  readonly #inFlight = new Set<Promise<unknown>>();

  constructor(options: InformationCoreOptions) {
    this.#drainTimeoutMs = options.drainTimeoutMs ?? 5000;
    if (!Number.isSafeInteger(this.#drainTimeoutMs) || this.#drainTimeoutMs < 0)
      throw new Error("Invalid core drain timeout");
    this.registry = options.registry;
    this.store = options.store;
    this.registry.registerBuiltin(consumerFailedInformationKind);
    this.registry.registerBuiltin(executionExhaustedInformationKind);
    this.registry.registerBuiltin(oneShotRequestedInformationKind);
    this.registry.registerBuiltin(oneShotDueInformationKind);
    this.registry.registerBuiltin(oneShotSupersededInformationKind);
    this.registry.registerBuiltin(oneShotFiredInformationKind);
    this.registry.registerBuiltin(oneShotFailedInformationKind);
    this.#bus = new InformationBus();
    this.#nextInformationId = options.nextInformationId;
    this.#now = options.now ?? (() => new Date());
    this.#bootstrapReporter = options.bootstrapReporter ?? (() => undefined);
    this.#logProjectionRunner = options.logProjectionRunner;
    this.#selectorExecutor = new InformationSelectorExecutor(
      this.store,
      options.retrievalStrategies,
    );
  }

  start(): Promise<void> {
    if (this.#state === "starting") {
      return this.#startPromise!;
    }
    if (this.#state === "started") {
      return Promise.resolve();
    }
    if (this.#state !== "new") {
      return Promise.reject(new InformationCoreClosedError());
    }
    this.#state = "starting";
    this.#startPromise = this.startCore();
    return this.#startPromise;
  }

  async register<K extends string, P extends JsonObject>(
    definition: InformationKindDefinition<K, P>,
    input: InformationRegistrationInput<K, P>,
  ): Promise<DeepReadonly<InformationAtom<K, P>>> {
    this.assertState("started");
    if (this.#execution.getStore())
      throw new Error(
        "Durable handlers must use registerOnce or commitTerminal",
      );
    const operation = this.registerInternal(definition, input, true);
    this.#inFlight.add(operation);
    void operation.then(
      () => this.#inFlight.delete(operation),
      () => this.#inFlight.delete(operation),
    );
    return operation;
  }

  onDurable<K extends string, P extends JsonObject>(
    subscriptionId: string,
    definition: InformationKindDefinition<K, P>,
    handle: (
      atom: DeepReadonly<InformationAtom<K, P>>,
      signal: AbortSignal,
    ) => Promise<void> | void,
  ): () => void {
    this.assertOpen();
    this.registry.assertRegistered(definition);
    if (this.#reliableRunner)
      throw new Error(
        "Durable subscriptions must be installed before delivery starts",
      );
    if (this.#durableSubscriptions.has(subscriptionId))
      throw new Error("Duplicate durable subscription ID");
    this.#durableSubscriptions.set(subscriptionId, {
      subscriptionId,
      kind: definition.kind,
      handle: handle as ReliableInformationSubscription["handle"],
    });
    return () => {
      this.#durableSubscriptions.delete(subscriptionId);
    };
  }
  async startReliableDelivery(): Promise<void> {
    this.assertState("started");
    if (this.#reliableRunner) return this.#reliableRunner.start();
    if (!this.store.reliable) {
      if (this.#durableSubscriptions.size)
        throw new Error("Reliable information ledger is required");
      return;
    }
    this.#reliableRunner = new ReliableInformationRunner({
      core: this,
      subscriptions: [...this.#durableSubscriptions.values()],
    });
    await this.#reliableRunner.start();
  }
  async stopReliableDelivery(options: { drain?: boolean } = {}): Promise<void> {
    await this.#reliableRunner?.stop(options);
  }
  async executionHealth() {
    if (!this.store.reliable)
      throw new Error("Reliable information ledger is required");
    return this.store.reliable.health();
  }

  get executionSignal(): AbortSignal | undefined {
    return this.#execution.getStore()?.signal;
  }

  withClaim<T>(
    claim: InformationClaim,
    signal: AbortSignal,
    run: () => Promise<T>,
  ): Promise<T> {
    return this.#execution.run({ claim, signal }, run);
  }

  registerOnce<K extends string, P extends JsonObject>(
    operation: string,
    key: string,
    definition: InformationKindDefinition<K, P>,
    input: InformationRegistrationInput<K, P>,
    guard?: InformationClaim,
  ): Promise<DeepReadonly<InformationAtom<K, P>>> {
    return this.registerUnique(definition, input, {
      type: "operation",
      namespace: operation,
      key,
      ...(guard ? { guard } : {}),
    });
  }

  commitTerminal<K extends string, P extends JsonObject>(
    group: string,
    subjectInformationId: InformationId,
    definition: InformationKindDefinition<K, P>,
    input: InformationRegistrationInput<K, P>,
    guard?: InformationClaim,
  ): Promise<DeepReadonly<InformationAtom>> {
    return this.registerUnique(definition, input, {
      type: "terminal",
      namespace: group,
      key: subjectInformationId,
      ...(guard ? { guard } : {}),
    });
  }

  async exhaustClaim(claim: InformationClaim): Promise<void> {
    await this.registerUnique(
      executionExhaustedInformationKind,
      {
        occurredAt: this.#now().toISOString(),
        source: "core:reliable-dag",
        payload: {
          subscriptionId: claim.subscriptionId,
          attempts: claim.attempt,
        },
        references: [
          { relation: "core:caused-by", informationId: claim.informationId },
          { relation: "core:status-of", informationId: claim.informationId },
        ],
      },
      { type: "exhaust", claim },
    );
  }

  private registerUnique<K extends string, P extends JsonObject>(
    definition: InformationKindDefinition<K, P>,
    input: InformationRegistrationInput<K, P>,
    unique: UniqueCommit,
  ): Promise<DeepReadonly<InformationAtom<K, P>>> {
    this.assertState("started");
    const execution = this.#execution.getStore();
    execution?.signal.throwIfAborted();
    if (unique.type !== "exhaust" && execution)
      unique = {
        ...unique,
        guard: { ...execution.claim, signal: execution.signal },
      };
    const operation = this.registerInternal(definition, input, true, unique);
    this.#inFlight.add(operation);
    void operation.then(
      () => this.#inFlight.delete(operation),
      () => this.#inFlight.delete(operation),
    );
    return operation;
  }

  on<K extends string, P extends JsonObject>(
    definition: InformationKindDefinition<K, P>,
    consumer: InformationConsumer,
    handler: (
      atom: DeepReadonly<InformationAtom<K, P>>,
    ) => unknown | Promise<unknown>,
  ): () => void {
    this.assertOpen();
    assertConsumerIdentity(consumer);
    const registered = this.registry.assertRegistered(
      definition as InformationKindDefinition<string, any>,
    ) as InformationKindDefinition<K, P>;
    return this.#bus.on(
      registered.kind,
      consumer,
      handler as InformationSubscriber,
    );
  }

  private async registerInternal<K extends string, P extends JsonObject>(
    definition: InformationKindDefinition<K, P>,
    input: InformationRegistrationInput<K, P>,
    recordConsumerFailures: boolean,
    unique?: UniqueCommit,
  ): Promise<DeepReadonly<InformationAtom<K, P>>> {
    const registered = this.registry.assertRegistered(
      definition as InformationKindDefinition<string, any>,
    ) as InformationKindDefinition<K, P>;

    const informationId = this.parseInformationId(this.#nextInformationId());
    const payload = registered.payloadSchema.parse(input.payload);
    const references = input.references.map((reference) =>
      informationReferenceSchema.parse(reference),
    );
    const candidate = informationAtomSchema.parse({
      informationId,
      kind: registered.kind,
      occurredAt: input.occurredAt,
      source: input.source,
      payload,
      references,
    }) as InformationAtom<K, P>;
    const atom = freezeInformationAtom(
      candidate as InformationAtom,
    ) as DeepReadonly<InformationAtom<K, P>>;

    const expectations = buildReferenceExpectations(registered.references);
    const appendOptions = { enqueueLogProjection: registered.log.enabled };
    if (unique) {
      const reliable = this.store.reliable;
      if (!reliable) throw new Error("Reliable information ledger is required");
      this.#execution.getStore()?.signal.throwIfAborted();
      if (unique.type === "exhaust") {
        await reliable.exhaust(unique.claim, atom, expectations);
      } else {
        const result =
          unique.type === "operation"
            ? await reliable.appendOnce(
                unique.namespace,
                unique.key,
                atom,
                expectations,
                appendOptions,
                unique.guard,
              )
            : await reliable.appendTerminal(
                unique.namespace,
                unique.key,
                atom,
                expectations,
                appendOptions,
                unique.guard,
              );
        if (!result.created)
          return result.atom as DeepReadonly<InformationAtom<K, P>>;
      }
    } else {
      await this.store.append(atom, expectations, appendOptions);
    }
    const outcomes = await this.#bus.publish(
      atom as unknown as InformationAtom,
    );
    if (recordConsumerFailures) {
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          await this.recordConsumerFailure(
            atom,
            outcome.consumer,
            outcome.reason,
          );
        }
      }
    } else {
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          await this.reportBootstrap(outcome.reason);
        }
      }
    }
    await this.projectPendingLogs();
    return atom;
  }

  async get(
    informationId: InformationId,
  ): Promise<DeepReadonly<InformationAtom> | undefined> {
    this.assertState("started");
    return this.store.get(informationId);
  }

  async scheduleOneShot(
    input: OneShotScheduleRequest,
  ): Promise<OneShotScheduleReceipt> {
    const schedules = this.store.oneShotSchedules;
    if (!schedules) throw new Error("One-shot scheduling is not configured");
    const atom = await this.buildOneShotAtom(
      oneShotRequestedInformationKind,
      {
        operationKey: input.operationKey,
        dueAt: input.dueAt,
        input: input.input,
        activation: { ...input.activation },
      },
      [
        {
          relation: "core:caused-by",
          informationId: input.sourceInformationId,
        },
        ...(input.references ?? []),
      ],
    );
    const guard = this.currentScheduleGuard();
    const result = await schedules.create({
      operationKey: input.operationKey,
      schedule: atom,
      dueAt: input.dueAt,
      ...(guard ? { guard } : {}),
    });
    return result;
  }

  async replaceOneShot(
    input: OneShotScheduleReplacement,
  ): Promise<OneShotReplacementReceipt> {
    const schedules = this.store.oneShotSchedules;
    if (!schedules) throw new Error("One-shot scheduling is not configured");
    const atom = await this.buildOneShotAtom(
      oneShotRequestedInformationKind,
      {
        operationKey: input.operationKey,
        dueAt: input.dueAt,
        input: input.input,
        activation: { ...input.activation },
      },
      [
        {
          relation: "core:caused-by",
          informationId: input.sourceInformationId,
        },
        {
          relation: "core:replaces",
          informationId: input.previousScheduleInformationId,
        },
        ...(input.references ?? []),
      ],
    );
    const superseded = await this.buildOneShotAtom(
      oneShotSupersededInformationKind,
      {},
      [
        {
          relation: "core:status-of",
          informationId: input.previousScheduleInformationId,
        },
      ],
    );
    const guard = this.currentScheduleGuard();
    return schedules.replace({
      operationKey: input.operationKey,
      previousScheduleInformationId: input.previousScheduleInformationId,
      schedule: atom,
      superseded,
      dueAt: input.dueAt,
      ...(guard ? { guard } : {}),
    });
  }

  async finishOneShot(
    input: OneShotTerminalRequest,
  ): Promise<OneShotTerminalResult> {
    const schedules = this.store.oneShotSchedules;
    if (!schedules) throw new Error("One-shot scheduling is not configured");
    const definition =
      input.status === "fired"
        ? oneShotFiredInformationKind
        : oneShotFailedInformationKind;
    const payload =
      input.status === "fired" ? {} : { failureKind: input.failureKind };
    const atom = await this.buildOneShotAtom(definition, payload, [
      {
        relation: "core:status-of",
        informationId: input.scheduleInformationId,
      },
    ]);
    const guard = this.currentScheduleGuard();
    return schedules.finish({
      scheduleInformationId: input.scheduleInformationId,
      terminal: atom,
      ...(guard ? { guard } : {}),
    });
  }

  private currentScheduleGuard(): OneShotFencingGuard | undefined {
    const execution = this.#execution.getStore();
    return execution
      ? { ...execution.claim, signal: execution.signal }
      : undefined;
  }

  private async buildOneShotAtom(
    definition: InformationKindDefinition<string, any>,
    payload: JsonObject,
    references: readonly InformationReference[],
  ): Promise<DeepReadonly<InformationAtom>> {
    this.assertState("started");
    const registered = this.registry.assertRegistered(
      definition as InformationKindDefinition<string, any>,
    );
    const parsedPayload = registered.payloadSchema.parse(payload);
    const parsedReferences = references.map((reference) =>
      informationReferenceSchema.parse(reference),
    );
    const atom = informationAtomSchema.parse({
      informationId: this.parseInformationId(this.#nextInformationId()),
      kind: registered.kind,
      occurredAt: this.#now().toISOString(),
      source: "core:scheduler",
      payload: parsedPayload,
      references: parsedReferences,
    });
    const expectations = buildReferenceExpectations(registered.references);
    const byRelation = new Map<string, InformationReference[]>();
    for (const reference of parsedReferences)
      byRelation.set(reference.relation, [
        ...(byRelation.get(reference.relation) ?? []),
        reference,
      ]);
    for (const reference of parsedReferences) {
      const expectation = expectations.find(
        (item) => item.relation === reference.relation,
      );
      if (!expectation)
        throw new InformationReferenceValidationError(
          registered.kind,
          reference.relation,
          "undeclared",
        );
      const target = await this.store.get(reference.informationId);
      if (!target)
        throw new InformationReferenceValidationError(
          registered.kind,
          reference.relation,
          "missing-target",
        );
      if (
        expectation.targetKinds &&
        !expectation.targetKinds.includes(target.kind)
      )
        throw new InformationReferenceValidationError(
          registered.kind,
          reference.relation,
          "target-kind",
        );
    }
    for (const expectation of expectations) {
      const values = byRelation.get(expectation.relation) ?? [];
      if (expectation.required && values.length === 0)
        throw new InformationReferenceValidationError(
          registered.kind,
          expectation.relation,
          "required",
        );
      if (!expectation.multiple && values.length > 1)
        throw new InformationReferenceValidationError(
          registered.kind,
          expectation.relation,
          "multiple",
        );
    }
    return freezeInformationAtom(atom as InformationAtom);
  }

  async getMany(
    informationIds: readonly InformationId[],
  ): Promise<readonly DeepReadonly<InformationAtom>[]> {
    this.assertState("started");
    return this.store.getMany(informationIds);
  }

  async find(
    query: InformationFindQuery,
  ): Promise<readonly DeepReadonly<InformationAtom>[]> {
    this.assertState("started");
    return this.store.find(query);
  }

  async select(
    selector: InformationSelectorDefinition,
    sourceInformationId: InformationId,
  ): Promise<readonly DeepReadonly<InformationAtom>[]> {
    this.assertState("started");
    return this.#selectorExecutor.select(
      selector,
      this.parseInformationId(sourceInformationId),
    );
  }

  async query(
    query: InformationReferenceQuery,
  ): Promise<readonly DeepReadonly<InformationAtom>[]> {
    this.assertState("started");
    return this.store.query(query);
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    if (this.#state === "closed") {
      return Promise.resolve();
    }
    const starting =
      this.#state === "starting" ? this.#startPromise : undefined;
    this.#state = "closing";
    this.#closePromise = (async () => {
      await starting?.catch(() => undefined);
      await this.stopReliableDelivery();
      await boundedCoreDrain(
        Promise.allSettled([...this.#inFlight]),
        this.#drainTimeoutMs,
      );
      await boundedCoreDrain(
        this.projectPendingLogs(true),
        this.#drainTimeoutMs,
      );
      this.#bus.clear();
      this.#state = "closed";
    })();
    return this.#closePromise;
  }

  private async startCore(): Promise<void> {
    try {
      this.registry.seal();
      await this.store.synchronizeKinds(
        this.registry.definitions().map((definition) => definition.kind),
      );
      if (this.#state !== "starting") {
        return;
      }
      await this.projectPendingLogs();
      if (this.#state === "starting") {
        this.#state = "started";
      }
    } catch (error) {
      if (this.#state !== "closing") {
        this.#state = "closed";
      }
      throw error;
    }
  }

  private async recordConsumerFailure(
    sourceAtom: DeepReadonly<InformationAtom>,
    consumer: InformationConsumer,
    reason: unknown,
  ): Promise<void> {
    try {
      await this.registerInternal(
        consumerFailedInformationKind,
        {
          occurredAt: this.#now().toISOString(),
          source: "core:information-core",
          payload: {
            consumer: {
              consumerId: consumer.consumerId,
              ...(consumer.definitionId === undefined
                ? {}
                : { definitionId: consumer.definitionId }),
              ...(consumer.instanceId === undefined
                ? {}
                : { instanceId: consumer.instanceId }),
            },
            error: summarizeConsumerError(reason),
          },
          references: [
            {
              relation: "core:caused-by",
              informationId: sourceAtom.informationId,
            },
            ...consumerFailureContextReferences(sourceAtom),
          ],
        },
        false,
      );
    } catch (error) {
      await this.reportBootstrap(error);
    }
  }

  private async reportBootstrap(error: unknown): Promise<void> {
    try {
      await this.#bootstrapReporter(error);
    } catch {
      // Bootstrap reporter 是最后一道诊断边界，不能制造未处理 rejection。
    }
  }

  private async projectPendingLogs(drain = false): Promise<void> {
    try {
      if (drain) {
        await this.#logProjectionRunner?.drainPending();
      } else {
        await this.#logProjectionRunner?.projectPending();
      }
    } catch {
      // Projection recovery is an observer of durable facts. It cannot make an
      // accepted atom append fail or force a rollback after commit.
    }
  }

  private parseInformationId(informationId: string): InformationId {
    try {
      return informationIdSchema.parse(informationId);
    } catch (cause) {
      throw new InvalidInformationIdError(informationId, cause);
    }
  }

  private assertState(expected: Exclude<CoreState, "closed">): void {
    if (this.#state === "closed") {
      throw new InformationCoreClosedError();
    }
    if (this.#state !== expected) {
      throw new InformationCoreNotStartedError();
    }
  }

  private assertOpen(): void {
    if (this.#state === "closing" || this.#state === "closed") {
      throw new InformationCoreClosedError();
    }
  }
}

function consumerFailureContextReferences(
  atom: DeepReadonly<InformationAtom>,
): InformationReference[] {
  const contexts = atom.references.filter(
    (reference) => reference.relation === "core:context",
  );
  return contexts.length === 1 ? [{ ...contexts[0]! }] : [];
}

function summarizeConsumerError(reason: unknown): {
  readonly errorType: string;
  readonly message: string;
} {
  if (isError(reason)) {
    return {
      errorType: "Error",
      message: "Consumer handler failed",
    };
  }
  return {
    errorType: "NonErrorRejection",
    message: "Consumer rejected with a non-Error value",
  };
}

function isError(value: unknown): boolean {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function assertConsumerIdentity(consumer: InformationConsumer): void {
  assertNonBlankConsumerField(consumer.consumerId, "consumerId", true);
  assertNonBlankConsumerField(consumer.definitionId, "definitionId", false);
  assertNonBlankConsumerField(consumer.instanceId, "instanceId", false);
}

function assertNonBlankConsumerField(
  value: unknown,
  field: "consumerId" | "definitionId" | "instanceId",
  required: boolean,
): void {
  if (value === undefined && !required) {
    return;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must not be blank`);
  }
}

function buildReferenceExpectations(
  references: Readonly<Record<string, InformationReferenceRule>>,
): readonly InformationReferenceExpectation[] {
  return Object.freeze(
    Object.entries(references).map(([relation, rule]) => {
      return rule.targetKinds === undefined
        ? Object.freeze({
            relation,
            required: rule.required,
            multiple: rule.multiple,
          })
        : Object.freeze({
            relation,
            required: rule.required,
            multiple: rule.multiple,
            targetKinds: rule.targetKinds,
          });
    }),
  );
}

async function boundedCoreDrain(
  work: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
