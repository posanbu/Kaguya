/**
 * 功能概述：验证 Core 执行 Information Selector 时的顺序、授权与加载边界。
 * 主要职责：使用真实 `InformationCore` 和内存账本覆盖有序返回、重复 ID、未知 ID、
 * 越权 ID、缺失 source 以及校验后原子消失等稳定失败语义。
 * 代码库关系：测试消费 SDK 的 `defineInformationSelector`，并面向 Engine 公共入口；
 * 账本替身实现与生产 `InformationLedger` 相同的结构化 find 和引用查询端口。
 * 输入输出与副作用：全部原子经真实 Core 注册并深冻结；无数据库或网络 I/O，测试间
 * 使用独立 Core 和每调用加载计数，避免共享授权状态。
 */
import {
  freezeInformationAtom,
  informationIdSchema,
  type DeepReadonly,
  type InformationAtom,
  type InformationId,
  z,
} from "@kaguya/schema";
import {
  defineInformationKind,
  defineInformationSelector,
  type InformationFindQuery,
  type InformationSelectorDefinition,
} from "@kaguya/sdk";
import { describe, expect, it } from "vitest";

import {
  DuplicateSelectedInformationIdError,
  InformationCore,
  InformationKindRegistry,
  InvalidSelectorQueryError,
  SelectedInformationMissingError,
  SelectorSourceInformationMissingError,
  UnauthorizedSelectedInformationIdError,
  UnknownRetrievalStrategyError,
  UnknownSelectedInformationIdError,
  type InformationLedger,
  type InformationRetrievalStrategy,
  type InformationReferenceExpectation,
  type InformationReferenceQuery,
} from "./index.js";

const sourceKind = defineInformationKind({
  kind: "acme.reply.requested",
  payloadSchema: z.object({ text: z.string() }).strict(),
  references: {},
  log: { enabled: false },
});

const memoryKind = defineInformationKind({
  kind: "acme.memory.text",
  payloadSchema: z.object({ text: z.string() }).strict(),
  references: {},
  log: { enabled: false },
});

class MemorySelectorLedger implements InformationLedger {
  readonly atoms = new Map<InformationId, DeepReadonly<InformationAtom>>();
  getManyCalls = 0;
  omitOnFinalLoad: InformationId | undefined;

  async synchronizeKinds(): Promise<void> {}

  async append(
    atom: DeepReadonly<InformationAtom>,
    _expectations: readonly InformationReferenceExpectation[],
  ): Promise<void> {
    this.atoms.set(
      atom.informationId,
      freezeInformationAtom(atom as InformationAtom),
    );
  }

  async get(informationId: InformationId) {
    return this.atoms.get(informationId);
  }

  async getMany(informationIds: readonly InformationId[]) {
    this.getManyCalls += 1;
    return informationIds.flatMap((informationId) => {
      if (this.getManyCalls >= 2 && informationId === this.omitOnFinalLoad) {
        return [];
      }
      const atom = this.atoms.get(informationId);
      return atom === undefined ? [] : [atom];
    });
  }

  async find(query: InformationFindQuery) {
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

  async query(query: InformationReferenceQuery) {
    return [...this.atoms.values()].filter((atom) =>
      atom.references.some(
        (reference) =>
          reference.informationId === query.informationId &&
          (query.relation === undefined ||
            reference.relation === query.relation),
      ),
    );
  }
}

async function fixture(
  retrievalStrategies: readonly InformationRetrievalStrategy[] = [],
) {
  const registry = new InformationKindRegistry();
  registry.register(sourceKind);
  registry.register(memoryKind);
  const ledger = new MemorySelectorLedger();
  const ids = ["source-1", "memory-1"];
  const core = new InformationCore({
    registry,
    store: ledger,
    nextInformationId: () => ids.shift() ?? "unexpected-id",
    retrievalStrategies,
  });
  await core.start();
  const source = await core.register(sourceKind, {
    occurredAt: "2026-09-04T00:00:00.000Z",
    source: "module:reply",
    payload: { text: "hello" },
    references: [],
  });
  const memory = await core.register(memoryKind, {
    occurredAt: "2026-09-04T00:00:01.000Z",
    source: "module:memory",
    payload: { text: "likes tea" },
    references: [],
  });
  return { core, ledger, source, memory };
}

function directAtom(input: {
  readonly informationId: string;
  readonly kind: string;
  readonly occurredAt: string;
  readonly payload?: Record<string, string>;
  readonly references?: readonly {
    readonly relation: string;
    readonly informationId: string;
  }[];
  readonly source?: string;
}): DeepReadonly<InformationAtom> {
  return freezeInformationAtom({
    informationId: informationIdSchema.parse(input.informationId),
    kind: input.kind,
    occurredAt: input.occurredAt,
    source: input.source ?? "module:test",
    payload: input.payload ?? {},
    references: [...(input.references ?? [])],
  });
}

function select(
  core: InformationCore,
  selector: InformationSelectorDefinition,
  sourceInformationId: InformationId,
): Promise<readonly DeepReadonly<InformationAtom>[]> {
  expect(core).toHaveProperty("select");
  return (
    core as InformationCore & {
      select(
        definition: InformationSelectorDefinition,
        sourceId: InformationId,
      ): Promise<readonly DeepReadonly<InformationAtom>[]>;
    }
  ).select(selector, sourceInformationId);
}

describe("Information Selector", () => {
  it("returns selected atoms in selector order", async () => {
    const { core, source, memory } = await fixture();
    const selector = defineInformationSelector({
      selectorId: "test.ordered",
      async select({ sourceAtom, ledger }) {
        const found = await ledger.find({
          kinds: [memoryKind.kind],
          limit: 10,
        });
        return [found[0]!.informationId, sourceAtom.informationId];
      },
    });

    const selected = await select(core, selector, source.informationId);
    expect(selected.map(({ informationId }) => informationId)).toEqual([
      memory.informationId,
      source.informationId,
    ]);
  });

  it("rejects duplicate selected ids", async () => {
    const { core, source } = await fixture();
    const selector = defineInformationSelector({
      selectorId: "test.duplicate",
      select: () => [source.informationId, source.informationId],
    });

    await expect(
      select(core, selector, source.informationId),
    ).rejects.toBeInstanceOf(DuplicateSelectedInformationIdError);
  });

  it("distinguishes unknown from unauthorized ids", async () => {
    const { core, source, memory } = await fixture();

    await expect(
      select(
        core,
        defineInformationSelector({
          selectorId: "test.unknown",
          select: () => ["missing-information"],
        }),
        source.informationId,
      ),
    ).rejects.toBeInstanceOf(UnknownSelectedInformationIdError);

    await expect(
      select(
        core,
        defineInformationSelector({
          selectorId: "test.unauthorized",
          select: () => [memory.informationId],
        }),
        source.informationId,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedSelectedInformationIdError);
  });

  it("rejects a missing selector source", async () => {
    const { core } = await fixture();
    const missing = informationIdSchema.parse("missing-source");

    await expect(
      select(
        core,
        defineInformationSelector({
          selectorId: "test.source-missing",
          select: () => [],
        }),
        missing,
      ),
    ).rejects.toBeInstanceOf(SelectorSourceInformationMissingError);
  });

  it("rejects an atom missing from the final reload", async () => {
    const { core, ledger, source, memory } = await fixture();
    ledger.omitOnFinalLoad = memory.informationId;

    await expect(
      select(
        core,
        defineInformationSelector({
          selectorId: "test.final-missing",
          async select({ ledger }) {
            const found = await ledger.find({
              kinds: [memoryKind.kind],
              limit: 1,
            });
            return [found[0]!.informationId];
          },
        }),
        source.informationId,
      ),
    ).rejects.toBeInstanceOf(SelectedInformationMissingError);
  });

  it.each([
    { limit: 10 },
    { kinds: [sourceKind.kind], limit: 0 },
    { kinds: [sourceKind.kind], limit: 1_001 },
  ] as const)(
    "requires a constrained find query and a valid limit",
    async (query) => {
      const { core, source } = await fixture();
      const selector = defineInformationSelector({
        selectorId: "test.invalid-find",
        async select({ ledger }) {
          await ledger.find(query);
          return [];
        },
      });

      await expect(
        select(core, selector, source.informationId),
      ).rejects.toBeInstanceOf(InvalidSelectorQueryError);
    },
  );

  it("loads outgoing references by source order and reference ordinal", async () => {
    const { core, ledger, source } = await fixture();
    for (const atom of [
      directAtom({
        informationId: "start-a",
        kind: "acme.related.start",
        occurredAt: "2026-09-04T00:01:00.000Z",
        references: [
          { relation: "acme:related", informationId: "target-b" },
          { relation: "acme:related", informationId: "target-a" },
        ],
      }),
      directAtom({
        informationId: "start-b",
        kind: "acme.related.start",
        occurredAt: "2026-09-04T00:02:00.000Z",
        references: [{ relation: "acme:related", informationId: "target-c" }],
      }),
      directAtom({
        informationId: "target-a",
        kind: "acme.related.target",
        occurredAt: "2026-09-04T00:03:00.000Z",
      }),
      directAtom({
        informationId: "target-b",
        kind: "acme.related.target",
        occurredAt: "2026-09-04T00:04:00.000Z",
      }),
      directAtom({
        informationId: "target-c",
        kind: "acme.related.target",
        occurredAt: "2026-09-04T00:05:00.000Z",
      }),
    ]) {
      ledger.atoms.set(atom.informationId, atom);
    }
    const selector = defineInformationSelector({
      selectorId: "test.outgoing",
      async select({ ledger }) {
        const starts = await ledger.find({
          kinds: ["acme.related.start"],
          limit: 10,
        });
        const related = await ledger.related({
          from: starts.map(({ informationId }) => informationId),
          relation: "acme:related",
          direction: "outgoing",
          limit: 10,
        });
        return related.map(({ informationId }) => informationId);
      },
    });

    const selected = await select(core, selector, source.informationId);
    expect(selected.map(({ informationId }) => informationId)).toEqual([
      "target-b",
      "target-a",
      "target-c",
    ]);
  });

  it("loads incoming references by source order and ledger order", async () => {
    const { core, ledger, source } = await fixture();
    for (const atom of [
      directAtom({
        informationId: "incoming-start-a",
        kind: "acme.incoming.start",
        occurredAt: "2026-09-04T00:01:00.000Z",
      }),
      directAtom({
        informationId: "incoming-start-b",
        kind: "acme.incoming.start",
        occurredAt: "2026-09-04T00:02:00.000Z",
      }),
      directAtom({
        informationId: "incoming-b",
        kind: "acme.incoming.result",
        occurredAt: "2026-09-04T00:04:00.000Z",
        references: [
          {
            relation: "acme:incoming",
            informationId: "incoming-start-a",
          },
        ],
      }),
      directAtom({
        informationId: "incoming-a",
        kind: "acme.incoming.result",
        occurredAt: "2026-09-04T00:03:00.000Z",
        references: [
          {
            relation: "acme:incoming",
            informationId: "incoming-start-a",
          },
        ],
      }),
      directAtom({
        informationId: "incoming-c",
        kind: "acme.incoming.result",
        occurredAt: "2026-09-04T00:05:00.000Z",
        references: [
          {
            relation: "acme:incoming",
            informationId: "incoming-start-b",
          },
        ],
      }),
    ]) {
      ledger.atoms.set(atom.informationId, atom);
    }
    const selector = defineInformationSelector({
      selectorId: "test.incoming",
      async select({ ledger }) {
        const starts = await ledger.find({
          kinds: ["acme.incoming.start"],
          limit: 10,
        });
        const related = await ledger.related({
          from: starts.map(({ informationId }) => informationId),
          relation: "acme:incoming",
          direction: "incoming",
          limit: 10,
        });
        return related.map(({ informationId }) => informationId);
      },
    });

    const selected = await select(core, selector, source.informationId);
    expect(selected.map(({ informationId }) => informationId)).toEqual([
      "incoming-b",
      "incoming-a",
      "incoming-c",
    ]);
  });

  it("rejects a related traversal whose start id is not authorized", async () => {
    const { core, source, memory } = await fixture();
    const selector = defineInformationSelector({
      selectorId: "test.related-unauthorized",
      async select({ ledger }) {
        await ledger.related({
          from: [memory.informationId],
          direction: "outgoing",
          limit: 1,
        });
        return [];
      },
    });

    await expect(
      select(core, selector, source.informationId),
    ).rejects.toMatchObject({
      constructor: UnauthorizedSelectedInformationIdError,
      informationId: memory.informationId,
    });
  });

  it("rejects an unknown retrieval strategy", async () => {
    const { core, source } = await fixture();
    const selector = defineInformationSelector({
      selectorId: "test.missing-retrieval",
      async select({ ledger }) {
        await ledger.retrieve({ strategyId: "missing", input: {}, limit: 1 });
        return [];
      },
    });

    await expect(
      select(core, selector, source.informationId),
    ).rejects.toBeInstanceOf(UnknownRetrievalStrategyError);
  });

  it("authorizes ids returned by a registered retrieval strategy", async () => {
    const { core, source, memory } = await fixture([
      {
        strategyId: "test.memory",
        retrieve: async () => [informationIdSchema.parse("memory-1")],
      },
    ]);
    const selector = defineInformationSelector({
      selectorId: "test.retrieval",
      async select({ ledger }) {
        const found = await ledger.retrieve({
          strategyId: "test.memory",
          input: { query: "tea" },
          limit: 1,
        });
        return found.map(({ informationId }) => informationId);
      },
    });

    const selected = await select(core, selector, source.informationId);
    expect(selected.map(({ informationId }) => informationId)).toEqual([
      memory.informationId,
    ]);
  });

  it("keeps concurrent selector authorization scopes isolated", async () => {
    const calls = new Map<string, () => void>();
    let arrivals = 0;
    const barrier = () =>
      new Promise<void>((resolve) => {
        arrivals += 1;
        calls.set(String(arrivals), resolve);
        if (arrivals === 2) {
          for (const release of calls.values()) release();
        }
      });
    const strategy: InformationRetrievalStrategy = {
      strategyId: "test.concurrent",
      async retrieve({ input }) {
        const key = String(input.key);
        return [informationIdSchema.parse(`candidate-${key}`)];
      },
    };
    const registry = new InformationKindRegistry();
    registry.register(sourceKind);
    registry.register(memoryKind);
    const ledger = new MemorySelectorLedger();
    const ids = ["source-A", "source-B", "candidate-A", "candidate-B"];
    const core = new InformationCore({
      registry,
      store: ledger,
      nextInformationId: () => ids.shift() ?? "unexpected-id",
      retrievalStrategies: [strategy],
    });
    await core.start();
    const sourceA = await core.register(sourceKind, {
      occurredAt: "2026-09-04T00:00:00.000Z",
      source: "module:reply",
      payload: { text: "A" },
      references: [],
    });
    const sourceB = await core.register(sourceKind, {
      occurredAt: "2026-09-04T00:00:01.000Z",
      source: "module:reply",
      payload: { text: "B" },
      references: [],
    });
    await core.register(memoryKind, {
      occurredAt: "2026-09-04T00:00:02.000Z",
      source: "module:memory",
      payload: { text: "A" },
      references: [],
    });
    await core.register(memoryKind, {
      occurredAt: "2026-09-04T00:00:03.000Z",
      source: "module:memory",
      payload: { text: "B" },
      references: [],
    });
    const selector = defineInformationSelector({
      selectorId: "test.concurrent",
      async select({ sourceAtom, ledger }) {
        const key = String(sourceAtom.payload.text);
        await ledger.retrieve({
          strategyId: "test.concurrent",
          input: { key },
          limit: 1,
        });
        await barrier();
        return [
          informationIdSchema.parse(`candidate-${key === "A" ? "B" : "A"}`),
        ];
      },
    });

    const results = await Promise.allSettled([
      core.select(selector, sourceA.informationId),
      core.select(selector, sourceB.informationId),
    ]);

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(
          UnauthorizedSelectedInformationIdError,
        );
      }
    }
  });
});
