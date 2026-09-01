/**
 * 架构说明：本测试覆盖信息 Core 的启动、追加、引用校验与订阅边界，
 * 以证明原子写入、快照隔离和 kind 注册之间的联动关系。
 * 代码库关系：`InformationCore` 连接 registry、store 与 bus；这里的测试
 * 使用内存 store double 来验证“先落库、后发布”的完整流程。
 */
import {
  type DeepReadonly,
  freezeInformationAtom,
  informationIdSchema,
  type InformationAtom,
  z,
} from "@kaguya/schema";
import { defineInformationKind, type InformationKindDefinition } from "@kaguya/sdk";
import { describe, expect, it } from "vitest";

import {
  InformationCore,
  InformationIdCollisionError,
  InformationReferenceValidationError,
  InvalidInformationIdError,
} from "./information-core.js";
import { InformationKindRegistry } from "./information-kind-registry.js";

const parentDefinition = defineInformationKind({
  kind: "acme.message.parent",
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

class MemoryInformationStore {
  readonly atoms = new Map<string, DeepReadonly<InformationAtom>>();
  readonly synchronisedKinds: string[][] = [];
  readonly appendOrder: string[] = [];

  constructor(
    private readonly options: { readonly onAppend?: (atom: InformationAtom) => void } = {},
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
  ): Promise<void> {
    if (this.atoms.has(atom.informationId)) {
      throw new InformationIdCollisionError(atom.informationId);
    }
    validateReferences(this.atoms, atom, expectations);
    this.appendOrder.push(atom.kind);
    this.options.onAppend?.(atom as InformationAtom);
    const snapshot = freezeInformationAtom(atom as InformationAtom);
    this.atoms.set(atom.informationId, snapshot);
  }

  async getById(
    informationId: string,
  ): Promise<DeepReadonly<InformationAtom> | undefined> {
    return this.atoms.get(informationId);
  }

  async listByReference(): Promise<DeepReadonly<InformationAtom>[]> {
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
    expectations.map((expectation) => [expectation.relation, expectation] as const),
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

function createStartedCore(
  store: MemoryInformationStore,
  kinds: readonly InformationKindDefinition<string, any>[],
) {
  const registry = new InformationKindRegistry();
  for (const kind of kinds) {
    registry.register(kind);
  }
  const core = new InformationCore({
    registry,
    store,
    nextInformationId: createDeterministicIdGenerator(),
  });
  return core.start().then(() => core);
}

function createCore(store: MemoryInformationStore, nextInformationId: () => string) {
  const registry = new InformationKindRegistry();
  registry.register(parentDefinition);
  const core = new InformationCore({
    registry,
    store,
    nextInformationId,
  });
  return core.start().then(() => core);
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

  it("rejects invalid ids and validates references before storing", async () => {
    const store = new MemoryInformationStore();
    const core = await createStartedCore(store, [parentDefinition, childDefinition]);
    const parent = await core.append(parentDefinition, {
      kind: parentDefinition.kind,
      occurredAt: "2026-09-01T00:00:00.000Z",
      source: "module:acme",
      payload: { text: "parent" },
      references: [],
    });

    await expect(
      core.append(childDefinition, {
        kind: childDefinition.kind,
        occurredAt: "2026-09-01T00:00:00.000Z",
        source: "module:acme",
        payload: { text: "child" },
        references: [
          { relation: "acme:parent", informationId: parent.informationId },
        ],
      }),
    ).resolves.toMatchObject({ kind: childDefinition.kind });

    await expect(
      core.append(childDefinition, {
        kind: childDefinition.kind,
        occurredAt: "2026-09-01T00:00:00.000Z",
        source: "module:acme",
        payload: { text: "child" },
        references: [],
      }),
    ).rejects.toBeInstanceOf(InformationReferenceValidationError);

    const badCore = await createCore(store, () => " ");
    await expect(
      badCore.append(parentDefinition, {
        kind: parentDefinition.kind,
        occurredAt: "2026-09-01T00:00:00.000Z",
        source: "module:acme",
        payload: { text: "bad" },
        references: [],
      }),
    ).rejects.toBeInstanceOf(InvalidInformationIdError);
  });
});
