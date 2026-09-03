/**
 * 架构说明：本测试覆盖信息 Core 的启动、追加、引用校验与订阅边界，
 * 以证明 registry、store 与 bus 组合后的写入路径只信任注册表中的正式定义，
 * 并且不会把可变输入、未注册 kind 或关闭后的调用继续放行。
 * 代码库关系：`InformationCore` 连接 registry、store 与 bus；这里的测试使用
 * 内存 store double 验证“先落库、后发布”、冻结快照、ID 冲突与关闭语义。
 */
import {
  type DeepReadonly,
  freezeInformationAtom,
  informationIdSchema,
  type InformationAtom,
  z,
} from "@kaguya/schema";
import {
  defineInformationKind,
  type InformationKindDefinition,
} from "@kaguya/sdk";
import { describe, expect, it } from "vitest";

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

class MemoryInformationStore {
  readonly atoms = new Map<string, DeepReadonly<InformationAtom>>();
  readonly synchronisedKinds: string[][] = [];
  readonly appendOrder: string[] = [];
  readonly appendOptions: { readonly enqueueLogProjection?: boolean }[] = [];

  constructor(
    private readonly options: {
      readonly onAppend?: (atom: DeepReadonly<InformationAtom>) => void;
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
    if (this.atoms.has(atom.informationId)) {
      throw new InformationIdCollisionError(atom.informationId);
    }
    validateReferences(this.atoms, atom, expectations);
    this.appendOrder.push(atom.kind);
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

  async getById(
    informationId: string,
  ): Promise<DeepReadonly<InformationAtom> | undefined> {
    return this.get(informationId);
  }

  async getMany(
    informationIds: readonly string[],
  ): Promise<DeepReadonly<InformationAtom>[]> {
    return informationIds.flatMap((informationId) => {
      const atom = this.atoms.get(informationId);
      return atom === undefined ? [] : [atom];
    });
  }

  async query(): Promise<DeepReadonly<InformationAtom>[]> {
    return [...this.atoms.values()];
  }
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
  it("persists before publishing and isolates observer failures", async () => {
    const order: string[] = [];
    const store = new MemoryInformationStore({
      onAppend: () => {
        order.push("store");
      },
    });
    const core = await createStartedCore(store, [parentDefinition]);

    core.subscribe(parentDefinition.kind, () => {
      order.push("observer");
      throw new Error("observer failed");
    });

    const atom = await core.append(parentDefinition, {
      kind: parentDefinition.kind,
      occurredAt: "2026-09-01T00:00:00.000Z",
      source: "module:acme",
      payload: { text: "moon" },
      references: [],
    });

    expect(order).toEqual(["store", "observer"]);
    expect((await store.getById(atom.informationId))?.payload).toEqual({
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
      },
    });

    await core.start();
    await core.append(loggedDefinition, {
      kind: loggedDefinition.kind,
      occurredAt: "2026-09-01T00:00:00.000Z",
      source: "module:acme",
      payload: { text: "moon" },
      references: [],
    });

    expect(store.appendOptions).toEqual([{ enqueueLogProjection: true }]);
    expect(projections).toBe(2);
  });

  it("rejects spoofed payload schemas and spoofed reference rules", async () => {
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
      core.append(spoofedPayloadDefinition, {
        kind: childDefinition.kind,
        occurredAt: "2026-09-01T00:00:00.000Z",
        source: "module:acme",
        payload: { spoof: "shadow" },
        references: [],
      }),
    ).rejects.toThrow();

    await expect(
      core.append(spoofedReferenceDefinition, {
        kind: childDefinition.kind,
        occurredAt: "2026-09-01T00:00:00.000Z",
        source: "module:acme",
        payload: { text: "child" },
        references: [],
      }),
    ).rejects.toBeInstanceOf(InformationReferenceValidationError);
  });

  it("rejects unknown definitions, collisions, and invalid ids", async () => {
    const store = new MemoryInformationStore();
    const core = await createStartedCore(store, [parentDefinition]);

    await expect(
      core.append(childDefinition, {
        kind: childDefinition.kind,
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
    await collisionCore.append(parentDefinition, {
      kind: parentDefinition.kind,
      occurredAt: "2026-09-01T00:00:00.000Z",
      source: "module:acme",
      payload: { text: "one" },
      references: [],
    });
    await expect(
      collisionCore.append(parentDefinition, {
        kind: parentDefinition.kind,
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
      invalidIdCore.append(parentDefinition, {
        kind: parentDefinition.kind,
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
    const parent = await declaredCore.append(parentDefinition, {
      kind: parentDefinition.kind,
      occurredAt: "2026-09-01T00:00:00.000Z",
      source: "module:acme",
      payload: { text: "parent" },
      references: [],
    });
    await expect(
      declaredCore.append(childDefinition, {
        kind: childDefinition.kind,
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
    const duplicateParent = await duplicateCore.append(parentDefinition, {
      kind: parentDefinition.kind,
      occurredAt: "2026-09-01T00:00:00.000Z",
      source: "module:acme",
      payload: { text: "parent" },
      references: [],
    });
    await expect(
      duplicateCore.append(childDefinition, {
        kind: childDefinition.kind,
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
    const otherParent = await mismatchedCore.append(otherParentDefinition, {
      kind: otherParentDefinition.kind,
      occurredAt: "2026-09-01T00:00:00.000Z",
      source: "module:acme",
      payload: { text: "other" },
      references: [],
    });
    await expect(
      mismatchedCore.append(childDefinition, {
        kind: childDefinition.kind,
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

    const pending = core.append(frozenDefinition, {
      kind: frozenDefinition.kind,
      occurredAt: "2026-09-01T00:00:00.000Z",
      source: "module:acme",
      payload,
      references,
    });
    payload.nested.values[0] = "changed";

    const atom = await pending;
    const stored = await core.getById(atom.informationId);

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

    core.subscribe(parentDefinition.kind, () => {
      observed += 1;
    });

    await core.close();

    expect(() =>
      core.subscribe(parentDefinition.kind, () => undefined),
    ).toThrow(InformationCoreClosedError);
    await expect(
      core.append(parentDefinition, {
        kind: parentDefinition.kind,
        occurredAt: "2026-09-01T00:00:00.000Z",
        source: "module:acme",
        payload: { text: "after-close" },
        references: [],
      }),
    ).rejects.toBeInstanceOf(InformationCoreClosedError);
    expect(observed).toBe(0);
  });
});
