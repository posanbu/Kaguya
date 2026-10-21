import { freezeInformationAtom, informationAtomSchema } from "@kaguya/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTestingDatabase,
  createPostgresTestingDatabase,
} from "./testing.js";
import {
  createNativeMemoryAccess,
  type NativeMemoryNode,
} from "@kaguya/memory";
const databases: Awaited<ReturnType<typeof createTestingDatabase>>[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((d) => d.close()));
});

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const node = (n: number, level = 0, scope = "scope-a"): NativeMemoryNode => ({
  id: id(n),
  content: `用户喜欢钢琴 ${n}`,
  metadata: {
    system: "native-v1",
    kind: "person",
    ownerId: "person:ada",
    scope,
    level,
    revision: 1,
    status: "active",
    locked: false,
    sourceIds: [],
    aliases: ["阿达"],
    tags: ["音乐"],
    occurredAt: "2026-10-20T00:00:00.000Z",
  },
});
const input = {
  scope: "scope-a",
  owners: ["person:ada"],
  asOf: "2026-10-21T00:00:00.000Z",
  query: "",
};
const connectionString = process.env.KAGUYA_TEST_DATABASE_URL;
if (process.env.KAGUYA_REQUIRE_POSTGRES_TESTS === "1" && !connectionString)
  throw new Error("KAGUYA_TEST_DATABASE_URL is required");
const backends = [
  { name: "PGlite", create: createTestingDatabase },
  ...(connectionString
    ? [
        {
          name: "PostgreSQL",
          create: () => createPostgresTestingDatabase(connectionString),
        },
      ]
    : []),
];
describe.each(backends)("native memory ($name)", ({ create }) => {
  async function setup() {
    const db = await create();
    databases.push(db);
    await db.prepareSchema();
    return db;
  }
  it("atomically publishes versions, rejects conflicts and preserves audit history", async () => {
    const db = await setup();
    const n = node(1);
    const p = {
      operationId: "one",
      actor: "manual" as const,
      nodes: [{ node: n, expectedRevision: 0 }],
    };
    expect(await db.memoryGraph.native.publish(p)).toEqual([n]);
    expect(await db.memoryGraph.native.publish(p)).toEqual([n]);
    await expect(
      db.memoryGraph.native.publish({ ...p, operationId: "other" }),
    ).rejects.toThrow("memory_revision_conflict");
    await expect(
      db.memoryGraph.native.publish({
        ...p,
        nodes: [{ node: { ...n, content: "changed" }, expectedRevision: 0 }],
      }),
    ).rejects.toThrow("memory_operation_conflict");
    expect(await db.memoryGraph.native.history(n.id)).toHaveLength(1);
    expect(
      (
        await db.sql.query(
          "SELECT * FROM information_atoms WHERE kind='memory.native.revision.v1'",
        )
      ).rows,
    ).toHaveLength(1);
  });
  it("enforces a unique active summary", async () => {
    const db = await setup();
    await db.memoryGraph.native.publish({
      operationId: "one",
      actor: "manual",
      nodes: [{ node: node(1), expectedRevision: 0 }],
    });
    await expect(
      db.memoryGraph.native.publish({
        operationId: "two",
        actor: "manual",
        nodes: [{ node: node(2), expectedRevision: 0 }],
      }),
    ).rejects.toThrow();
  });
  it("invalidates summaries when details change and validates hierarchy", async () => {
    const db = await setup();
    const a = node(1),
      b = node(2, 1);
    await db.memoryGraph.native.publish({
      operationId: "one",
      actor: "manual",
      nodes: [
        { node: a, expectedRevision: 0 },
        { node: b, expectedRevision: 0 },
      ],
      edges: [{ sourceId: a.id, targetId: b.id, relation: "summarizes" }],
    });
    await db.memoryGraph.native.publish({
      operationId: "two",
      actor: "manual",
      nodes: [
        {
          node: {
            ...b,
            content: "修正为小提琴",
            metadata: { ...b.metadata, revision: 2 },
          },
          expectedRevision: 1,
        },
      ],
    });
    expect(await db.memoryGraph.native.readFixed(input)).toEqual([]);
    expect((await db.memoryGraph.getNode(a.id))?.metadata.revision).toBe(2);
    await expect(
      db.memoryGraph.native.publish({
        operationId: "bad",
        actor: "manual",
        expectedVersions: { [a.id]: 2, [b.id]: 2 },
        nodes: [],
        edges: [{ sourceId: b.id, targetId: a.id, relation: "summarizes" }],
      }),
    ).rejects.toThrow("memory_invalid_edge");
  });
  it("injects fixed summaries without a query and degrades failed vector retrieval independently", async () => {
    const db = await setup();
    await db.memoryGraph.native.publish({
      operationId: "one",
      actor: "manual",
      nodes: [
        { node: node(1), expectedRevision: 0 },
        { node: node(2, 2), expectedRevision: 0 },
      ],
    });
    const memory = createNativeMemoryAccess({
      enabled: true,
      store: db.memoryGraph.native,
      retrievers: [
        {
          role: "semantic",
          identity: "broken",
          search: async () => {
            throw Error("unavailable");
          },
        },
      ],
    });
    const snapshot = await memory.freeze(input);
    expect(snapshot.fixed.map((n) => n.id)).toEqual([id(1)]);
    expect(snapshot.degraded).toEqual(["semantic"]);
    expect(snapshot.recalled.map((r) => r.node.id)).toContain(id(2));
    expect(
      (
        await createNativeMemoryAccess({
          enabled: false,
          store: db.memoryGraph.native,
        }).freeze(input)
      ).status,
    ).toBe("disabled");
  });
  it("follows links without shared words and does not cross scope boundaries", async () => {
    const db = await setup();
    const a = node(1, 1),
      b = {
        ...node(2, 2),
        content: "完全不同的词",
        metadata: { ...node(2, 2).metadata, ownerId: "experience:one" },
      },
      hidden = node(3, 2, "scope-b");
    await db.memoryGraph.native.publish({
      operationId: "one",
      actor: "manual",
      nodes: [a, b, hidden].map((node) => ({ node, expectedRevision: 0 })),
      edges: [
        { sourceId: a.id, targetId: b.id, relation: "related" },
        { sourceId: b.id, targetId: hidden.id, relation: "related" },
      ],
    });
    const results = await db.memoryGraph.native.expand(input, [a.id]);
    expect(results.map((r) => r.node.id)).toEqual([b.id]);
  });
  it("serializes concurrent publication and preserves IDs when relevelled", async () => {
    const db = await setup();
    const a = node(1),
      b = node(2, 1);
    await db.memoryGraph.native.publish({
      operationId: "initial",
      actor: "manual",
      nodes: [a, b].map((node) => ({ node, expectedRevision: 0 })),
    });
    const results = await Promise.allSettled(
      ["a", "b"].map((operationId) =>
        db.memoryGraph.native.publish({
          operationId,
          actor: "manual",
          nodes: [
            {
              expectedRevision: 1,
              node: {
                ...a,
                content: operationId,
                metadata: { ...a.metadata, revision: 2 },
              },
            },
          ],
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await db.memoryGraph.native.publish({
      operationId: "relevel",
      actor: "manual",
      nodes: [
        {
          expectedRevision: 2,
          node: { ...a, metadata: { ...a.metadata, level: 3, revision: 3 } },
        },
        {
          expectedRevision: 1,
          node: { ...b, metadata: { ...b.metadata, level: 0, revision: 2 } },
        },
      ],
    });
    expect(
      (await db.memoryGraph.native.readFixed(input)).map((n) => n.id),
    ).toEqual([b.id]);
    expect((await db.memoryGraph.getNode(a.id))?.metadata.level).toBe(3);
  });
  it("rejects automatic overwrite of locked nodes and optimistic edge conflicts", async () => {
    const db = await setup();
    const a = { ...node(1), metadata: { ...node(1).metadata, locked: true } },
      b = node(2, 2);
    await db.memoryGraph.native.publish({
      operationId: "initial",
      actor: "manual",
      nodes: [a, b].map((node) => ({ node, expectedRevision: 0 })),
    });
    await expect(
      db.memoryGraph.native.publish({
        operationId: "automatic",
        actor: "automatic",
        nodes: [
          {
            expectedRevision: 1,
            node: { ...a, metadata: { ...a.metadata, revision: 2 } },
          },
        ],
      }),
    ).rejects.toThrow("memory_node_locked");
    await expect(
      db.memoryGraph.native.publish({
        operationId: "edge",
        actor: "manual",
        nodes: [],
        expectedVersions: { [a.id]: 1, [b.id]: 2 },
        edges: [{ sourceId: a.id, targetId: b.id, relation: "related" }],
      }),
    ).rejects.toThrow("memory_revision_conflict");
    expect(await db.memoryGraph.listEdges({ nodeId: a.id })).toEqual([]);
  });
  it.each(["阿达", "阿答", "ADA", "月", "astronomy"])(
    "retrieves short names, aliases and fuzzy text: %s",
    async (query) => {
      const db = await setup();
      const a = {
        ...node(1, 2),
        metadata: {
          ...node(1, 2).metadata,
          aliases: ["阿达", "Ada", "月", "astronomy"],
        },
      };
      await db.memoryGraph.native.publish({
        operationId: "initial",
        actor: "manual",
        nodes: [{ node: a, expectedRevision: 0 }],
      });
      const hits = await db.memoryGraph.native.candidates({
        ...input,
        owners: [],
        query,
      });
      expect(hits.map((h) => h.node.id)).toContain(a.id);
      expect(await db.memoryGraph.listEdges({ nodeId: a.id })).toEqual([]);
    },
  );

  it("keeps the cutover watermark across restart and excludes legacy evidence", async () => {
    const db = await setup();
    await db.information.synchronizeKinds(["test.memory.source"]);
    const append = async (id: string) =>
      db.information.append(
        freezeInformationAtom(
          informationAtomSchema.parse({
            informationId: id,
            kind: "test.memory.source",
            occurredAt: "2026-10-20T00:00:00Z",
            source: "test:memory",
            payload: { text: id },
            references: [],
          }),
        ),
        [],
      );
    await append("old-source");
    await db.sql.exec("DROP TABLE memory_native_epoch");
    await db.prepareSchema();
    const source = (id: string) => ({
      id,
      scope: "scope-a",
      ownerId: "person:ada",
      text: id,
      sourceType: "inbound" as const,
      participants: [],
      replyTo: null,
      collectedAt: "2026-10-20T00:00:00Z",
      occurredAt: "2026-10-20T00:00:00Z",
    });
    expect(await db.memoryGraph.native.ingest(source("old-source"))).toBe(
      false,
    );
    await append("new-source");
    expect(await db.memoryGraph.native.ingest(source("new-source"))).toBe(true);
    await db.prepareSchema();
    expect(await db.memoryGraph.native.ingest(source("old-source"))).toBe(
      false,
    );
    const a = node(1);
    await expect(
      db.memoryGraph.native.publish({
        operationId: "legacy",
        actor: "automatic",
        nodes: [
          {
            expectedRevision: 0,
            node: {
              ...a,
              metadata: { ...a.metadata, sourceIds: ["old-source"] },
            },
          },
        ],
      }),
    ).rejects.toThrow("memory_evidence_before_epoch");
    expect(
      await db.memoryGraph.native.claim(
        "scope-a",
        true,
        "2026-10-20T00:00:59Z",
      ),
    ).toBeUndefined();
    expect(
      (
        await db.memoryGraph.native.claim(
          "scope-a",
          true,
          "2026-10-20T00:01:00Z",
        )
      )?.sources.map((s) => s.id),
    ).toEqual(["new-source"]);
  });

  it("keeps fixed context complete when dynamic and expression budgets are exhausted", async () => {
    const db = await setup();
    const summaries = Array.from({ length: 5 }, (_, i) => ({
      ...node(i + 1),
      metadata: { ...node(i + 1).metadata, ownerId: `person:${i}` },
    }));
    const details = Array.from({ length: 12 }, (_, i) => ({
      ...node(i + 10, 2),
      content: "详细经历".repeat(1200),
      metadata: { ...node(i + 10, 2).metadata, ownerId: "person:0" },
    }));
    await db.memoryGraph.native.publish({
      operationId: "large",
      actor: "manual",
      nodes: [...summaries, ...details].map((node) => ({
        node,
        expectedRevision: 0,
      })),
    });
    const snapshot = await createNativeMemoryAccess({
      enabled: true,
      store: db.memoryGraph.native,
      retrievers: [
        {
          role: "semantic",
          identity: "unavailable-semantic",
          search: async () => {
            throw Error("offline");
          },
        },
        {
          role: "language",
          identity: "unavailable-language",
          search: async () => {
            throw Error("offline");
          },
        },
      ],
    }).freeze({ ...input, owners: summaries.map((n) => n.metadata.ownerId) });
    expect(snapshot.fixed.map((n) => n.id).sort()).toEqual(
      summaries.map((n) => n.id).sort(),
    );
    expect(snapshot.budget.dynamicCharacters).toBe(4000);
    expect(snapshot.budget.omittedNodeIds.length).toBeGreaterThan(0);
    expect(snapshot.degraded.sort()).toEqual(["language", "semantic"]);
  });
  it("distinguishes a disabled module from enabled read failure", async () => {
    const db = await setup();
    vi.spyOn(db.memoryGraph.native, "withReadSnapshot").mockRejectedValue(
      new Error("read-unavailable"),
    );
    await expect(
      createNativeMemoryAccess({
        enabled: true,
        store: db.memoryGraph.native,
      }).freeze(input),
    ).rejects.toThrow("read-unavailable");
    expect(
      (
        await createNativeMemoryAccess({
          enabled: false,
          store: db.memoryGraph.native,
        }).freeze(input)
      ).status,
    ).toBe("disabled");
  });
});
