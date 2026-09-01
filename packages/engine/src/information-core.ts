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

export interface InformationAtomStore {
  synchronizeKinds(kinds: readonly string[]): Promise<void>;
  append(
    atom: DeepReadonly<InformationAtom>,
    expectations: readonly InformationReferenceExpectation[],
  ): Promise<void>;
  getById(
    informationId: InformationId,
  ): Promise<DeepReadonly<InformationAtom> | undefined>;
  listByReference(
    query: InformationReferenceQuery,
  ): Promise<readonly DeepReadonly<InformationAtom>[]>;
}

export interface InformationCoreOptions {
  readonly registry: InformationKindRegistry;
  readonly store: InformationAtomStore;
  readonly nextInformationId: () => string;
  readonly now?: () => Date;
  readonly bus?: InformationBusOptions;
}

type InformationSubscriber = (
  atom: DeepReadonly<InformationAtom>,
) => unknown | Promise<unknown>;

type CoreState = "new" | "started" | "closed";

export class InformationCore {
  readonly registry: InformationKindRegistry;
  readonly store: InformationAtomStore;
  #bus: InformationBus;
  #nextInformationId: () => string;
  #now: () => Date;
  #state: CoreState = "new";

  constructor(options: InformationCoreOptions) {
    this.registry = options.registry;
    this.store = options.store;
    this.#bus = new InformationBus(options.bus);
    this.#nextInformationId = options.nextInformationId;
    this.#now = options.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    this.assertState("new");
    this.registry.seal();
    await this.store.synchronizeKinds(
      this.registry.definitions().map((definition) => definition.kind),
    );
    this.#state = "started";
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
    const atom = freezeInformationAtom(candidate as InformationAtom) as DeepReadonly<
      InformationAtom<K, P>
    >;

    await this.store.append(atom, buildReferenceExpectations(registered.references));
    return this.#bus.publish(atom as unknown as InformationAtom) as Promise<
      DeepReadonly<InformationAtom<K, P>>
    >;
  }

  async getById(
    informationId: InformationId,
  ): Promise<DeepReadonly<InformationAtom> | undefined> {
    this.assertState("started");
    return this.store.getById(informationId);
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

  subscribeAll(
    handler: InformationSubscriber,
  ): () => void {
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
      throw new Error(`Append input kind must match definition kind: ${definition.kind}`);
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
