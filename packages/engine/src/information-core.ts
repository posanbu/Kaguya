/**
 * 架构说明：本模块把 registry、store 与 bus 组合成信息 Core，
 * 负责启动前注册同步、注册时的 ID 生成、引用 expectations 传递、并发广播与故障事实。
 * 主要职责：`register` 校验、落账并广播新 atom；`on` 校验非空 typed consumer 身份后订阅；
 * `get`/`getMany`/`find`/`query` 只读账本；公开写入和订阅分别只有 `register` 与 typed `on`。
 * 代码库关系：Core 是信息原子体系的入口编排层，依赖 Registry、Ledger 与 Bus；
 * `information-kinds.ts` 提供唯一的 `consumer.failed` 定义，Runtime 后续复用它。
 * 输入输出与副作用：提交成功才广播当前快照，拒绝的消费者被记录为失败 atom；失败
 * atom 的消费者或持久化失败只进入 bootstrap reporter，绝不递归产生故障链；失败事实
 * 会继承输入唯一的 `core:context`，Error rejection 的类型固定为 `Error`。start/close 共享
 * promise；关闭先拒绝新注册、等待已接受的落账和广播，再排空日志投影并清理订阅，
 * 确保并发调用不能重复初始化、复活 Core 或泄漏原异常正文。
 */
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
} from "@kaguya/sdk";

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
  readonly registry: InformationKindRegistry;
  readonly store: InformationLedger;
  readonly nextInformationId: () => string;
  readonly now?: () => Date;
  readonly bootstrapReporter?: (error: unknown) => void | Promise<void>;
  readonly logProjectionRunner?: InformationLogProjectionRunner;
}

type CoreState = "new" | "starting" | "started" | "closing" | "closed";

export class InformationCore {
  readonly registry: InformationKindRegistry;
  readonly store: InformationLedger;
  #bus: InformationBus;
  #nextInformationId: () => string;
  #now: () => Date;
  #bootstrapReporter: (error: unknown) => void | Promise<void>;
  #logProjectionRunner: InformationLogProjectionRunner | undefined;
  #state: CoreState = "new";
  #startPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  readonly #inFlight = new Set<Promise<unknown>>();

  constructor(options: InformationCoreOptions) {
    this.registry = options.registry;
    this.store = options.store;
    this.registry.registerBuiltin(consumerFailedInformationKind);
    this.#bus = new InformationBus();
    this.#nextInformationId = options.nextInformationId;
    this.#now = options.now ?? (() => new Date());
    this.#bootstrapReporter = options.bootstrapReporter ?? (() => undefined);
    this.#logProjectionRunner = options.logProjectionRunner;
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
    const operation = this.registerInternal(definition, input, true);
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

    await this.store.append(
      atom,
      buildReferenceExpectations(registered.references),
      {
        enqueueLogProjection: registered.log.enabled,
      },
    );
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

  async getMany(
    informationIds: readonly InformationId[],
  ): Promise<readonly DeepReadonly<InformationAtom>[]> {
    this.assertState("started");
    return this.store.getMany(informationIds);
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
      await Promise.allSettled([...this.#inFlight]);
      await this.projectPendingLogs(true);
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
