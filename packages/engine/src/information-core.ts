/**
 * 架构说明：本模块把 registry、store 与 bus 组合成信息 Core，
 * 负责启动前注册同步、追加时的 ID 生成、引用 expectations 传递与订阅分发。
 * 代码库关系：Core 是信息原子体系的入口编排层，后续 Runtime 与 PostgreSQL
 * 存储实现都会依赖这里定义的 store 端口和追加语义。
 */
import {
  type DeepReadonly,
  freezeInformationAtom,
  informationAtomSchema,
  informationIdSchema,
  informationReferenceSchema,
  type InformationAtom,
  type InformationId,
  type JsonObject,
} from "@kaguya/schema";
import type {
  InformationAppendInput,
  InformationKindDefinition,
  InformationReferenceRule,
} from "@kaguya/sdk";

import {
  InformationBus,
  type InformationBusOptions,
} from "./information-bus.js";
import {
  InformationCoreClosedError,
  InformationCoreNotStartedError,
  InformationIdCollisionError,
  InvalidInformationIdError,
  InformationReferenceValidationError,
} from "./information-errors.js";
import { InformationKindRegistry } from "./information-kind-registry.js";

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
  query(
    query: InformationReferenceQuery,
  ): Promise<readonly DeepReadonly<InformationAtom>[]>;
}

/** @deprecated Use InformationLedger. Kept for #38 consumers. */
export type InformationAtomStore = InformationLedger;

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
}

export interface InformationCoreOptions {
  readonly registry: InformationKindRegistry;
  readonly store: InformationLedger;
  readonly nextInformationId: () => string;
  readonly now?: () => Date;
  readonly bus?: InformationBusOptions;
  readonly logProjectionRunner?: InformationLogProjectionRunner;
}

type InformationSubscriber = (
  atom: DeepReadonly<InformationAtom>,
) => unknown | Promise<unknown>;

type CoreState = "new" | "started" | "closed";

export class InformationCore {
  readonly registry: InformationKindRegistry;
  readonly store: InformationLedger;
  #bus: InformationBus;
  #nextInformationId: () => string;
  #now: () => Date;
  #logProjectionRunner: InformationLogProjectionRunner | undefined;
  #state: CoreState = "new";

  constructor(options: InformationCoreOptions) {
    this.registry = options.registry;
    this.store = options.store;
    this.#bus = new InformationBus(options.bus);
    this.#nextInformationId = options.nextInformationId;
    this.#now = options.now ?? (() => new Date());
    this.#logProjectionRunner = options.logProjectionRunner;
  }

  async start(): Promise<void> {
    this.assertState("new");
    this.registry.seal();
    await this.store.synchronizeKinds(
      this.registry.definitions().map((definition) => definition.kind),
    );
    this.#state = "started";
    await this.projectPendingLogs();
  }

  async append<K extends string, P extends JsonObject>(
    definition: InformationKindDefinition<K, P>,
    input: InformationAppendInput<K, P>,
  ): Promise<DeepReadonly<InformationAtom<K, P>>> {
    this.assertState("started");
    const registered = this.registry.assertRegistered(
      definition as InformationKindDefinition<string, any>,
    ) as InformationKindDefinition<K, P>;
    this.assertAppendKind(registered, input);

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
    const published = (await this.#bus.publish(
      atom as unknown as InformationAtom,
    )) as DeepReadonly<InformationAtom<K, P>>;
    await this.projectPendingLogs();
    return published;
  }

  async get(
    informationId: InformationId,
  ): Promise<DeepReadonly<InformationAtom> | undefined> {
    this.assertState("started");
    return this.store.get(informationId);
  }

  /** @deprecated Use get(). */
  async getById(
    informationId: InformationId,
  ): Promise<DeepReadonly<InformationAtom> | undefined> {
    return this.get(informationId);
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

  /** @deprecated Use query(). */
  async listByReference(
    query: InformationReferenceQuery,
  ): Promise<readonly DeepReadonly<InformationAtom>[]> {
    return this.query(query);
  }

  subscribe<K extends string, P extends JsonObject>(
    kind: string,
    handler: (
      atom: DeepReadonly<InformationAtom<K, P>>,
    ) => unknown | Promise<unknown>,
  ): () => void {
    this.assertOpen();
    return this.#bus.subscribe(kind, handler as InformationSubscriber);
  }

  subscribeAll(handler: InformationSubscriber): () => void {
    this.assertOpen();
    return this.#bus.subscribeAll(handler);
  }

  async close(): Promise<void> {
    if (this.#state === "closed") {
      return;
    }
    this.#bus.clear();
    this.#state = "closed";
  }

  private assertAppendKind<K extends string, P extends JsonObject>(
    definition: InformationKindDefinition<K, P>,
    input: InformationAppendInput<K, P>,
  ): void {
    if (definition.kind !== input.kind) {
      throw new Error(
        `Append input kind must match definition kind: ${definition.kind}`,
      );
    }
  }

  private async projectPendingLogs(): Promise<void> {
    try {
      await this.#logProjectionRunner?.projectPending();
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
    if (this.#state === "closed") {
      throw new InformationCoreClosedError();
    }
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
