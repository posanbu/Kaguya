/**
 * 功能概述：本测试覆盖信息 Core 的启动、注册、definition/消费者身份校验、并发消费者与故障事实边界，
 * 以证明 registry、store 与 bus 组合后的写入路径只信任注册表中的正式定义，
 * 并且不会把可变输入、未注册 kind 或关闭后的调用继续放行。
 * 主要职责：验证最终 `register/on/get/find/query` API、落账先于广播、引用校验、深冻结、
 * ID 冲突、消费者失败固定分类、抛出型错误 getter、共享 start/close promise、closing
 * 阶段拒绝订阅、关闭等待在途广播及最终日志排空。
 * 代码库关系：`InformationCore` 连接 registry、store 与 bus；这里的测试使用
 * 内存 ledger double 验证“先落库、后并发发布”、冻结快照、失败递归保护、故障 context
 * 继承、ID 冲突与关闭语义；不会以 mock 掩盖账本和广播的实际交互。
 * 输入输出与副作用：只操作内存 ledger 与同步 registry；异步消费者通过真实 bus 并发，
 * bootstrap reporter 仅用 spy 观察，不访问数据库或网络。
 */
import {
  type DeepReadonly,
  freezeInformationAtom,
  informationIdSchema,
  type InformationAtom,
  type JsonObject,
  z,
} from "@kaguya/schema";
import {
  defineInformationKind,
  type InformationFindQuery,
  type InformationKindDefinition,
} from "@kaguya/sdk";
import { describe, expect, it, vi } from "vitest";

import {
  InformationCore,
  InformationCoreClosedError,
  InformationIdCollisionError,
  InformationReferenceValidationError,
  InvalidInformationIdError,
} from "./information-core.js";
import {
  InformationKindRegistry,
  UnknownInformationKindError,
} from "./information-kind-registry.js";

const parentDefinition = defineInformationKind({
  kind: "acme.message.parent",
  payloadSchema: z.object({ text: z.string() }).strict(),
  references: {},
  log: { enabled: false },
});

const otherParentDefinition = defineInformationKind({
  kind: "acme.message.other-parent",
  payloadSchema: z.object({ text: z.string() }).strict(),
  references: {},
  log: { enabled: false },
});

const runtimeContextDefinition = defineInformationKind({
  kind: "core.runtime.context",
  payloadSchema: z.object({}).strict(),
  references: {},
  log: { enabled: false },
});

const contextualParentDefinition = defineInformationKind({
  kind: "acme.message.contextual-parent",
  payloadSchema: z.object({ text: z.string() }).strict(),
  references: {
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: [runtimeContextDefinition.kind],
    },
  },
  log: { enabled: false },
});

const childDefinition = defineInformationKind({
  kind: "acme.message.child",
  payloadSchema: z.object({ text: z.string() }).strict(),
  references: {
    "acme:parent": {
      required: true,
      multiple: false,
      targetKinds: [parentDefinition.kind],
    },
  },
  log: { enabled: false },
});

const frozenDefinition = defineInformationKind({
  kind: "acme.message.frozen",
  payloadSchema: z
    .object({
      nested: z
        .object({
          values: z.array(z.string()),
        })
        .strict(),
    })
    .strict(),
  references: {},
  log: { enabled: false },
});

const consumerFailedKind = "consumer.failed";

class MemoryInformationStore {
  readonly atoms = new Map<string, DeepReadonly<InformationAtom>>();
  readonly synchronisedKinds: string[][] = [];
  readonly appendOrder: string[] = [];
  readonly appendOptions: { readonly enqueueLogProjection?: boolean }[] = [];
  readonly operations: string[] = [];

  constructor(
    private readonly options: {
      readonly onAppend?: (atom: DeepReadonly<InformationAtom>) => void;
      readonly rejectAppend?: (atom: DeepReadonly<InformationAtom>) => boolean;
    } = {},
  ) {}

  async synchronizeKinds(kinds: readonly string[]): Promise<void> {
    this.synchronisedKinds.push([...kinds]);
  }

  async append(
    atom: DeepReadonly<InformationAtom>,
    expectations: readonly {
      readonly relation: string;
      readonly required: boolean;
      readonly multiple: boolean;
      readonly targetKinds?: readonly string[];
    }[],
    options: { readonly enqueueLogProjection?: boolean } = {},
  ): Promise<void> {
    if (this.options.rejectAppend?.(atom)) {
      throw new Error(`append rejected: ${atom.kind}`);
    }
    if (this.atoms.has(atom.informationId)) {
      throw new InformationIdCollisionError(atom.informationId);
    }
    validateReferences(this.atoms, atom, expectations);
    this.appendOrder.push(atom.kind);
    this.operations.push(`append:${atom.informationId}`);
    this.appendOptions.push(options);
    this.options.onAppend?.(atom);
    const snapshot = freezeInformationAtom(atom as InformationAtom);
    this.atoms.set(atom.informationId, snapshot);
  }

  async get(
    informationId: string,
  ): Promise<DeepReadonly<InformationAtom> | undefined> {
    return this.atoms.get(informationId);
  }

  async getMany(
    informationIds: readonly string[],
  ): Promise<DeepReadonly<InformationAtom>[]> {
    return informationIds.flatMap((informationId) => {
      const atom = this.atoms.get(informationId);
      return atom === undefined ? [] : [atom];
    });
  }

  async find(
    query: InformationFindQuery,
  ): Promise<DeepReadonly<InformationAtom>[]> {
    return [...this.atoms.values()]
      .filter(
        (atom) =>
          (query.kinds === undefined || query.kinds.includes(atom.kind)) &&
          (query.sources === undefined ||
            query.sources.includes(atom.source)) &&
          (query.occurredAfter === undefined ||
            Date.parse(atom.occurredAt) >= Date.parse(query.occurredAfter)) &&
          (query.occurredBefore === undefined ||
            Date.parse(atom.occurredAt) < Date.parse(query.occurredBefore)),
      )
      .sort(
        (left, right) =>
          Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
          left.informationId.localeCompare(right.informationId),
      )
      .slice(0, query.limit);
  }

  async query(): Promise<DeepReadonly<InformationAtom>[]> {
    return [...this.atoms.values()];
  }
}

function registration<P extends JsonObject>(payload: P) {
  return {
    occurredAt: "2026-09-04T00:00:00.000Z",
    source: "adapter:test",
    payload,
    references: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function validateReferences(
  atoms: Map<string, DeepReadonly<InformationAtom>>,
  atom: DeepReadonly<InformationAtom>,
  expectations: readonly {
    readonly relation: string;
    readonly required: boolean;
    readonly multiple: boolean;
    readonly targetKinds?: readonly string[];
  }[],
): void {
  const expectationsByRelation = new Map(
    expectations.map(
      (expectation) => [expectation.relation, expectation] as const,
    ),
  );
  const seen = new Map<string, number>();

  for (const reference of atom.references) {
    const expectation = expectationsByRelation.get(reference.relation);
    if (expectation === undefined) {
      throw new InformationReferenceValidationError(
        atom.kind,
        reference.relation,
        "undeclared",
      );
    }
    if (!expectation.multiple && seen.has(reference.relation)) {
      throw new InformationReferenceValidationError(
        atom.kind,
        reference.relation,
        "multiple",
      );
    }
    seen.set(reference.relation, (seen.get(reference.relation) ?? 0) + 1);
    const target = atoms.get(reference.informationId);
    if (target === undefined) {
      throw new InformationReferenceValidationError(
        atom.kind,
        reference.relation,
        "missing-target",
      );
    }
    if (
      expectation.targetKinds !== undefined &&
      !expectation.targetKinds.includes(target.kind)
    ) {
      throw new InformationReferenceValidationError(
        atom.kind,
        reference.relation,
        "target-kind",
      );
    }
  }

  for (const expectation of expectations) {
    if (expectation.required !== true) {
      continue;
    }
    if ((seen.get(expectation.relation) ?? 0) === 0) {
      throw new InformationReferenceValidationError(
        atom.kind,
        expectation.relation,
        "required",
      );
    }
  }
}

async function createStartedCore(
  store: MemoryInformationStore,
  kinds: readonly InformationKindDefinition<string, any>[],
): Promise<InformationCore> {
  const registry = new InformationKindRegistry();
  for (const kind of kinds) {
    registry.register(kind);
  }
  const core = new InformationCore({
    registry,
    store,
    nextInformationId: createDeterministicIdGenerator(),
  });
  await core.start();
  return core;
}

async function createCoreWithGenerator(
  store: MemoryInformationStore,
  nextInformationId: () => string,
  kinds: readonly InformationKindDefinition<string, any>[],
): Promise<InformationCore> {
  const registry = new InformationKindRegistry();
  for (const kind of kinds) {
    registry.register(kind);
  }
  const core = new InformationCore({
    registry,
    store,
    nextInformationId,
  });
  await core.start();
  return core;
}

function createDeterministicIdGenerator() {
  let sequence = 0;
  return () => `atom-${++sequence}`;
}

describe("InformationCore", () => {
  it.each([
    [{ consumerId: "" }, "consumerId"],
    [{ consumerId: "   " }, "consumerId"],
    [{ consumerId: "consumer", definitionId: "" }, "definitionId"],
    [{ consumerId: "consumer", definitionId: "   " }, "definitionId"],
    [{ consumerId: "consumer", instanceId: "" }, "instanceId"],
    [{ consumerId: "consumer", instanceId: "   " }, "instanceId"],
  ] as const)("rejects a blank consumer %s", async (consumer, field) => {
    const core = await createStartedCore(new MemoryInformationStore(), [
      parentDefinition,
    ]);

    expect(() => core.on(parentDefinition, consumer, () => undefined)).toThrow(
      `${field} must not be blank`,
    );
  });

  it("rejects a same-kind definition that is not the registered object", async () => {
    const fakeDefinition = defineInformationKind({
      kind: parentDefinition.kind,
      payloadSchema: z.object({ other: z.string() }).strict(),
      references: {},
      log: { enabled: false },
    });
    const core = await createStartedCore(new MemoryInformationStore(), [
      parentDefinition,
    ]);

    expect(() =>
      core.on(
        fakeDefinition,
        { consumerId: "fake-definition" },
        () => undefined,
      ),
    ).toThrow(`Information kind definition mismatch: ${parentDefinition.kind}`);
  });

  it("starts every current consumer concurrently after commit", async () => {
    const started: string[] = [];
    const release = deferred<void>();
    const ledger = new MemoryInformationStore();
    const core = await createStartedCore(ledger, [parentDefinition]);

    core.on(parentDefinition, { consumerId: "first" }, async () => {
      started.push("first");
      await release.promise;
    });
    core.on(parentDefinition, { consumerId: "second" }, async () => {
      started.push("second");
      await release.promise;
    });

    const registering = core.register(
      parentDefinition,
      registration({ text: "月" }),
    );
    await vi.waitFor(() =>
      expect(new Set(started)).toEqual(new Set(["first", "second"])),
    );
    expect(ledger.operations.slice(0, 1)).toEqual(["append:atom-1"]);
    release.resolve();
    await registering;
  });

  it("persists an atom without consumers so it remains readable", async () => {
    const ledger = new MemoryInformationStore();
    const core = await createStartedCore(ledger, [parentDefinition]);

    const atom = await core.register(
      parentDefinition,
      registration({ text: "moon" }),
    );

    await expect(core.get(atom.informationId)).resolves.toEqual(atom);
  });

  it("does not start consumers when the ledger rejects the commit", async () => {
    let calls = 0;
    const ledger = new MemoryInformationStore({ rejectAppend: () => true });
    const core = await createStartedCore(ledger, [parentDefinition]);
    core.on(parentDefinition, { consumerId: "observer" }, () => {
      calls += 1;
    });

    await expect(
      core.register(parentDefinition, registration({ text: "moon" })),
    ).rejects.toThrow("append rejected");
    expect(calls).toBe(0);
  });

  it("does not replay atoms committed before a consumer subscribes", async () => {
    const seen: string[] = [];
    const ledger = new MemoryInformationStore();
    const core = await createStartedCore(ledger, [parentDefinition]);
    await core.register(parentDefinition, registration({ text: "before" }));

    core.on(parentDefinition, { consumerId: "late" }, (atom) => {
      seen.push(atom.payload.text);
    });
    await core.register(parentDefinition, registration({ text: "after" }));

    expect(seen).toEqual(["after"]);
  });

  it("keeps successful consumers independent from a failing consumer", async () => {
    const completed: string[] = [];
    const ledger = new MemoryInformationStore();
    const core = await createStartedCore(ledger, [parentDefinition]);
    core.on(parentDefinition, { consumerId: "failing" }, () => {
      throw new Error("consumer exploded");
    });
    core.on(parentDefinition, { consumerId: "successful" }, () => {
      completed.push("successful");
    });

    await core.register(parentDefinition, registration({ text: "moon" }));

    expect(completed).toEqual(["successful"]);
  });

  it("records one consumer.failed atom without context when its source has none", async () => {
    const ledger = new MemoryInformationStore();
    const core = await createStartedCore(ledger, [parentDefinition]);
    core.on(
      parentDefinition,
      { consumerId: "failing", definitionId: "acme.worker", instanceId: "one" },
      () => {
        throw new TypeError("consumer exploded");
      },
    );

    const source = await core.register(
      parentDefinition,
      registration({ text: "moon" }),
    );
    const failures = [...ledger.atoms.values()].filter(
      (atom) => atom.kind === consumerFailedKind,
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      payload: {
        consumer: {
          consumerId: "failing",
          definitionId: "acme.worker",
          instanceId: "one",
        },
        error: { errorType: "Error", message: "Consumer handler failed" },
      },
      references: [
        { relation: "core:caused-by", informationId: source.informationId },
      ],
    });
    expect(failures[0]?.payload).not.toHaveProperty("stack");
  });

  it("inherits the source atom's single context on consumer.failed", async () => {
    const ledger = new MemoryInformationStore();
    const registry = new InformationKindRegistry();
    registry.registerBuiltin(runtimeContextDefinition);
    registry.register(contextualParentDefinition);
    const core = new InformationCore({
      registry,
      store: ledger,
      nextInformationId: createDeterministicIdGenerator(),
    });
    await core.start();
    core.on(
      contextualParentDefinition,
      { consumerId: "contextual-failure" },
      () => {
        throw new Error("consumer exploded");
      },
    );
    const context = await core.register(runtimeContextDefinition, {
      occurredAt: "2026-09-04T00:00:00.000Z",
      source: "runtime:test",
      payload: {},
      references: [],
    });

    const source = await core.register(contextualParentDefinition, {
      occurredAt: "2026-09-04T00:00:01.000Z",
      source: "runtime:test",
      payload: { text: "moon" },
      references: [
        {
          relation: "core:context",
          informationId: context.informationId,
        },
      ],
    });

    const failure = [...ledger.atoms.values()].find(
      (atom) => atom.kind === consumerFailedKind,
    );
    expect(failure?.references).toEqual([
      { relation: "core:caused-by", informationId: source.informationId },
      { relation: "core:context", informationId: context.informationId },
    ]);
    expect(core.registry.get(consumerFailedKind).references).toMatchObject({
      "core:context": { required: false, multiple: false },
    });
  });

  it("replaces an overlong error name before recording consumer.failed", async () => {
    const ledger = new MemoryInformationStore();
    const core = await createStartedCore(ledger, [parentDefinition]);
    const error = new Error("consumer exploded");
    error.name = "x".repeat(129);
    core.on(parentDefinition, { consumerId: "failing" }, () => {
      throw error;
    });

    await core.register(parentDefinition, registration({ text: "moon" }));

    const failure = [...ledger.atoms.values()].find(
      (atom) => atom.kind === consumerFailedKind,
    );
    expect(failure).toMatchObject({
      payload: {
        error: { errorType: "Error" },
      },
    });
  });

  it("does not retry a consumer after it fails", async () => {
    let calls = 0;
    const ledger = new MemoryInformationStore();
    const core = await createStartedCore(ledger, [parentDefinition]);
    core.on(parentDefinition, { consumerId: "failing" }, () => {
      calls += 1;
      throw new Error("consumer exploded");
    });

    await core.register(parentDefinition, registration({ text: "moon" }));

    expect(calls).toBe(1);
  });

  it("does not recursively record a failure from a consumer.failed consumer", async () => {
    const ledger = new MemoryInformationStore();
    const core = await createStartedCore(ledger, [parentDefinition]);
    core.on(parentDefinition, { consumerId: "failing" }, () => {
      throw new Error("input failed");
    });
    core.on(
      core.registry.get(consumerFailedKind),
      { consumerId: "failure-observer" },
      () => {
        throw new Error("failure observer failed");
      },
    );

    await core.register(parentDefinition, registration({ text: "moon" }));

    expect(
      [...ledger.atoms.values()].filter(
        (atom) => atom.kind === consumerFailedKind,
      ),
    ).toHaveLength(1);
  });

  it("reports to bootstrap when it cannot commit a consumer.failed atom", async () => {
    const bootstrapReporter = vi.fn();
    const ledger = new MemoryInformationStore({
      rejectAppend: (atom) => atom.kind === consumerFailedKind,
    });
    const registry = new InformationKindRegistry();
    registry.register(parentDefinition);
    const core = new InformationCore({
      registry,
      store: ledger,
      nextInformationId: createDeterministicIdGenerator(),
      bootstrapReporter,
    });
    await core.start();
    core.on(parentDefinition, { consumerId: "failing" }, () => {
      throw new Error("input failed");
    });

    await core.register(parentDefinition, registration({ text: "moon" }));

    expect(bootstrapReporter).toHaveBeenCalledTimes(1);
    expect([...ledger.atoms.values()]).toHaveLength(1);
  });

  it("persists before publishing and isolates observer failures", async () => {
    const order: string[] = [];
    const store = new MemoryInformationStore({
      onAppend: () => {
        order.push("store");
      },
    });
    const core = await createStartedCore(store, [parentDefinition]);

    core.on(parentDefinition, { consumerId: "observer" }, () => {
      order.push("observer");
      throw new Error("observer failed");
    });

    const atom = await core.register(parentDefinition, {
      occurredAt: "2026-09-01T00:00:00.000Z",
      source: "module:acme",
      payload: { text: "moon" },
      references: [],
    });

    expect(order).toEqual(["store", "observer", "store"]);
    expect((await store.get(atom.informationId))?.payload).toEqual({
      text: "moon",
    });
  });

  it("queues enabled kind logs after commit and replays pending logs at startup", async () => {
    const loggedDefinition = defineInformationKind({
      kind: "acme.runtime.logged",
      payloadSchema: z.object({ text: z.string() }).strict(),
      references: {},
      log: {
        enabled: true,
        level: "info",
        project: () => ({ event: "acme.runtime.logged" }),
      },
    });
    const store = new MemoryInformationStore();
    let projections = 0;
    const registry = new InformationKindRegistry();
    registry.register(loggedDefinition);
    const core = new InformationCore({
      registry,
      store,
      nextInformationId: createDeterministicIdGenerator(),
      logProjectionRunner: {
        projectPending: async () => {
          projections += 1;
        },
        drainPending: async () => undefined,
      },
    });

    await core.start();
    await core.register(loggedDefinition, {
      occurredAt: "2026-09-01T00:00:00.000Z",
      source: "module:acme",
      payload: { text: "moon" },
      references: [],
    });

    expect(store.appendOptions).toEqual([{ enqueueLogProjection: true }]);
    expect(projections).toBe(2);
  });

  it("shares concurrent startup and cannot become started after close begins", async () => {
    const synchronized = deferred<void>();
    const release = deferred<void>();
    const store = new MemoryInformationStore();
    const synchronize = vi
      .spyOn(store, "synchronizeKinds")
      .mockImplementation(async (kinds) => {
        store.synchronisedKinds.push([...kinds]);
        synchronized.resolve();
        await release.promise;
      });
    const registry = new InformationKindRegistry();
    registry.register(parentDefinition);
    const core = new InformationCore({
      registry,
      store,
      nextInformationId: createDeterministicIdGenerator(),
    });

    const firstStart = core.start();
    const secondStart = core.start();
    expect(secondStart).toBe(firstStart);
    await synchronized.promise;
    const closing = core.close();
    release.resolve();

    await expect(Promise.all([firstStart, closing])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(synchronize).toHaveBeenCalledOnce();
    await expect(
      core.register(parentDefinition, registration({ text: "closed" })),
    ).rejects.toBeInstanceOf(InformationCoreClosedError);
  });

  it("waits for an accepted broadcast before clearing subscribers", async () => {
    const store = new MemoryInformationStore();
    const core = await createStartedCore(store, [parentDefinition]);
    const entered = deferred<void>();
    const release = deferred<void>();
    let completed = false;
    core.on(parentDefinition, { consumerId: "slow" }, async () => {
      entered.resolve();
      await release.promise;
      completed = true;
    });

    const registrationPromise = core.register(
      parentDefinition,
      registration({ text: "accepted" }),
    );
    await entered.promise;
    const closePromise = core.close();
    expect(core.close()).toBe(closePromise);
    let closed = false;
    void closePromise.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    release.resolve();
    await Promise.all([registrationPromise, closePromise]);
    expect(completed).toBe(true);
  });

  it("drains all pending log batches while closing", async () => {
    const store = new MemoryInformationStore();
    const registry = new InformationKindRegistry();
    registry.register(parentDefinition);
    const drainPending = vi.fn(async () => undefined);
    const core = new InformationCore({
      registry,
      store,
      nextInformationId: createDeterministicIdGenerator(),
      logProjectionRunner: {
        projectPending: async () => undefined,
        drainPending,
      } as any,
    });

    await core.start();
    await core.close();

    expect(drainPending).toHaveBeenCalledOnce();
  });

  it("rejects subscriptions while close is still draining", async () => {
    const store = new MemoryInformationStore();
    const registry = new InformationKindRegistry();
    registry.register(parentDefinition);
    const draining = deferred<void>();
    const release = deferred<void>();
    const core = new InformationCore({
      registry,
      store,
      nextInformationId: createDeterministicIdGenerator(),
      logProjectionRunner: {
        projectPending: async () => undefined,
        drainPending: async () => {
          draining.resolve();
          await release.promise;
        },
      },
    });
    await core.start();

    const closing = core.close();
    await draining.promise;
    expect(() =>
      core.on(parentDefinition, { consumerId: "too-late" }, () => undefined),
    ).toThrow(InformationCoreClosedError);
    release.resolve();
    await closing;
  });

  it("rejects spoofed definition objects before payload or reference validation", async () => {
    const store = new MemoryInformationStore();
    const core = await createStartedCore(store, [
      parentDefinition,
      childDefinition,
    ]);
    const spoofedPayloadDefinition = defineInformationKind({
      kind: childDefinition.kind,
      payloadSchema: z.object({ spoof: z.string() }).strict(),
      references: {},
      log: { enabled: false },
    });
    const spoofedReferenceDefinition = defineInformationKind({
      kind: childDefinition.kind,
      payloadSchema: z.object({ text: z.string() }).strict(),
      references: {},
      log: { enabled: false },
    });

    await expect(
      core.register(spoofedPayloadDefinition, {
        occurredAt: "2026-09-01T00:00:00.000Z",
        source: "module:acme",
        payload: { spoof: "shadow" },
        references: [],
      }),
    ).rejects.toThrow(
      `Information kind definition mismatch: ${childDefinition.kind}`,
    );

    await expect(
      core.register(spoofedReferenceDefinition, {
        occurredAt: "2026-09-01T00:00:00.000Z",
        source: "module:acme",
        payload: { text: "child" },
        references: [],
      }),
    ).rejects.toThrow(
      `Information kind definition mismatch: ${childDefinition.kind}`,
    );
  });

  it("rejects unknown definitions, collisions, and invalid ids", async () => {
    const store = new MemoryInformationStore();
    const core = await createStartedCore(store, [parentDefinition]);

    await expect(
      core.register(childDefinition, {
        occurredAt: "2026-09-01T00:00:00.000Z",
        source: "module:acme",
        payload: { text: "child" },
        references: [],
      }),
    ).rejects.toBeInstanceOf(UnknownInformationKindError);

    const collisionCore = await createCoreWithGenerator(
      store,
      () => "atom-collision",
      [parentDefinition],
    );
    await collisionCore.register(parentDefinition, {
      occurredAt: "2026-09-01T00:00:00.000Z",
      source: "module:acme",
      payload: { text: "one" },
      references: [],
    });
    await expect(
      collisionCore.register(parentDefinition, {
        occurredAt: "2026-09-01T00:00:00.000Z",
        source: "module:acme",
        payload: { text: "two" },
        references: [],
      }),
    ).rejects.toBeInstanceOf(InformationIdCollisionError);

    const invalidIdCore = await createCoreWithGenerator(
      new MemoryInformationStore(),
      () => " ",
      [parentDefinition],
    );
    await expect(
      invalidIdCore.register(parentDefinition, {
        occurredAt: "2026-09-01T00:00:00.000Z",
        source: "module:acme",
        payload: { text: "bad" },
        references: [],
      }),
    ).rejects.toBeInstanceOf(InvalidInformationIdError);
  });

  it("rejects undeclared, duplicate, and mismatched reference targets", async () => {
    const declaredStore = new MemoryInformationStore();
    const declaredCore = await createStartedCore(declaredStore, [
      parentDefinition,
      childDefinition,
    ]);
    const parent = await declaredCore.register(parentDefinition, {
      occurredAt: "2026-09-01T00:00:00.000Z",
      source: "module:acme",
      payload: { text: "parent" },
      references: [],
    });
    await expect(
      declaredCore.register(childDefinition, {
        occurredAt: "2026-09-01T00:00:00.000Z",
        source: "module:acme",
        payload: { text: "child" },
        references: [
          { relation: "acme:parent", informationId: parent.informationId },
          { relation: "acme:rogue", informationId: parent.informationId },
        ],
      }),
    ).rejects.toBeInstanceOf(InformationReferenceValidationError);

    const duplicateCore = await createStartedCore(
      new MemoryInformationStore(),
      [parentDefinition, childDefinition],
    );
    const duplicateParent = await duplicateCore.register(parentDefinition, {
      occurredAt: "2026-09-01T00:00:00.000Z",
      source: "module:acme",
      payload: { text: "parent" },
      references: [],
    });
    await expect(
      duplicateCore.register(childDefinition, {
        occurredAt: "2026-09-01T00:00:00.000Z",
        source: "module:acme",
        payload: { text: "child" },
        references: [
          {
            relation: "acme:parent",
            informationId: duplicateParent.informationId,
          },
          {
            relation: "acme:parent",
            informationId: duplicateParent.informationId,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(InformationReferenceValidationError);

    const mismatchedCore = await createStartedCore(
      new MemoryInformationStore(),
      [otherParentDefinition, childDefinition],
    );
    const otherParent = await mismatchedCore.register(otherParentDefinition, {
      occurredAt: "2026-09-01T00:00:00.000Z",
      source: "module:acme",
      payload: { text: "other" },
      references: [],
    });
    await expect(
      mismatchedCore.register(childDefinition, {
        occurredAt: "2026-09-01T00:00:00.000Z",
        source: "module:acme",
        payload: { text: "child" },
        references: [
          { relation: "acme:parent", informationId: otherParent.informationId },
        ],
      }),
    ).rejects.toBeInstanceOf(InformationReferenceValidationError);
  });

  it("does not mutate caller aliases and returns deeply frozen reads", async () => {
    const store = new MemoryInformationStore();
    const core = await createStartedCore(store, [frozenDefinition]);
    const payload = { nested: { values: ["moon"] } };
    const references: [] = [];

    const pending = core.register(frozenDefinition, {
      occurredAt: "2026-09-01T00:00:00.000Z",
      source: "module:acme",
      payload,
      references,
    });
    payload.nested.values[0] = "changed";

    const atom = await pending;
    const stored = await core.get(atom.informationId);

    expect(atom.payload).toEqual({ nested: { values: ["moon"] } });
    expect(stored).toBeDefined();
    expect(stored).not.toBeUndefined();
    expect(Object.isFrozen(stored as object)).toBe(true);
    expect(Object.isFrozen(stored!.payload)).toBe(true);
    const frozenPayload = stored!.payload as {
      readonly nested: {
        readonly values: readonly string[];
      };
    };
    expect(Object.isFrozen(frozenPayload.nested)).toBe(true);
    expect(Object.isFrozen(frozenPayload.nested.values)).toBe(true);
    expect(stored!.payload).toEqual({ nested: { values: ["moon"] } });
  });

  it("stops new work after close", async () => {
    const store = new MemoryInformationStore();
    const core = await createStartedCore(store, [parentDefinition]);
    let observed = 0;

    core.on(parentDefinition, { consumerId: "observer" }, () => {
      observed += 1;
    });

    await core.close();

    expect(() =>
      core.on(parentDefinition, { consumerId: "closed" }, () => undefined),
    ).toThrow(InformationCoreClosedError);
    await expect(
      core.register(parentDefinition, {
        occurredAt: "2026-09-01T00:00:00.000Z",
        source: "module:acme",
        payload: { text: "after-close" },
        references: [],
      }),
    ).rejects.toBeInstanceOf(InformationCoreClosedError);
    expect(observed).toBe(0);
  });

  it("redacts unsafe Error names and messages from consumer failure facts", async () => {
    const store = new MemoryInformationStore();
    const core = await createStartedCore(store, [parentDefinition]);
    const credential = "postgresql://admin:very-secret@db.internal/kaguya";
    const failure = new Error(`failed with ${credential}`);
    failure.name = `CredentialError:${credential}`;
    core.on(parentDefinition, { consumerId: "unsafe-error" }, () => {
      throw failure;
    });

    await core.register(parentDefinition, registration({ text: "moon" }));

    const fact = [...store.atoms.values()].find(
      (atom) => atom.kind === consumerFailedKind,
    );
    expect(fact?.payload).toMatchObject({
      error: {
        errorType: "Error",
        message: "Consumer handler failed",
      },
    });
    expect(JSON.stringify(fact)).not.toContain("very-secret");
    expect(JSON.stringify(fact)).not.toContain("postgresql://");
  });

  it("does not treat an alphanumeric secret as a safe consumer error type", async () => {
    const store = new MemoryInformationStore();
    const core = await createStartedCore(store, [parentDefinition]);
    const failure = new Error("DatabasePassword123 message");
    failure.name = "DatabasePassword123";
    core.on(parentDefinition, { consumerId: "secret-name" }, () => {
      throw failure;
    });

    await core.register(parentDefinition, registration({ text: "moon" }));

    const fact = [...store.atoms.values()].find(
      (atom) => atom.kind === consumerFailedKind,
    );
    expect(fact?.payload).toMatchObject({
      error: { errorType: "Error", message: "Consumer handler failed" },
    });
    expect(JSON.stringify(fact)).not.toContain("DatabasePassword123");
  });

  it("records a safe fact when an Error name getter throws", async () => {
    const store = new MemoryInformationStore();
    const core = await createStartedCore(store, [parentDefinition]);
    const failure = new Error("getter-secret");
    Object.defineProperty(failure, "name", {
      get() {
        throw new Error("name-getter-secret");
      },
    });
    core.on(parentDefinition, { consumerId: "throwing-name" }, () => {
      throw failure;
    });

    await core.register(parentDefinition, registration({ text: "moon" }));

    const fact = [...store.atoms.values()].find(
      (atom) => atom.kind === consumerFailedKind,
    );
    expect(fact?.payload).toMatchObject({
      error: { errorType: "Error", message: "Consumer handler failed" },
    });
    expect(JSON.stringify(fact)).not.toContain("getter-secret");
  });
});
