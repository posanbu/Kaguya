/** Real pgvector projections with deterministic external embeddings. */
/** Real pgvector projections with deterministic external embeddings. */
import { it, expect } from "vitest";
import { createTestingDatabase } from "./testing.js";
import { PostgresNativeVectorRetriever } from "./native-memory-vector.js";
import {
  createNativeMemoryAccess,
  type NativeMemoryNode,
} from "@kaguya/memory";
it("isolates role/model spaces and rejects stale versions until rebuilt", async () => {
  const db = await createTestingDatabase({ vector: true });
  try {
    await db.prepareSchema();
    const node: NativeMemoryNode = {
      id: "00000000-0000-4000-8000-000000000001",
      content: "星空",
      metadata: {
        system: "native-v1",
        kind: "experience",
        ownerId: "person:a",
        scope: "allowed",
        level: 2,
        revision: 1,
        status: "active",
        locked: false,
        sourceIds: [],
        aliases: [],
        tags: [],
        occurredAt: "2026-10-20T00:00:00Z",
      },
    };
    await db.memoryGraph.native.publish({
      operationId: "one",
      actor: "manual",
      nodes: [{ node, expectedRevision: 0 }],
    });
    const provider = {
      identity: { modelId: "provider/model", revision: "v1", dimensions: 2 },
      embed: async () => [1, 0],
    };
    const semantic = new PostgresNativeVectorRetriever(db.sql, {
      role: "semantic",
      provider,
      timeoutMs: 100,
    });
    const language = new PostgresNativeVectorRetriever(db.sql, {
      role: "language",
      provider: {
        ...provider,
        identity: { ...provider.identity, revision: "v2" },
      },
      timeoutMs: 100,
    });
    await semantic.index();
    await language.index();
    const query = {
      scope: "allowed",
      owners: ["person:a"],
      asOf: "2026-10-21T00:00:00Z",
      query: "无共同词",
    };
    expect(
      await semantic.search(query, new AbortController().signal),
    ).toHaveLength(1);
    const frozen = await createNativeMemoryAccess({
      enabled: true,
      store: db.memoryGraph.native,
      retrievers: [semantic, language],
    }).freeze(query);
    expect(frozen.degraded).toEqual([]);
    expect(frozen.recalled[0]?.traces.map((t) => t.channel)).toEqual(
      expect.arrayContaining(["semantic", "language"]),
    );
    expect(
      await language.search(
        { ...query, scope: "other" },
        new AbortController().signal,
      ),
    ).toEqual([]);
    await db.memoryGraph.native.publish({
      operationId: "two",
      actor: "manual",
      nodes: [
        {
          node: {
            ...node,
            content: "新的经历",
            metadata: { ...node.metadata, revision: 2 },
          },
          expectedRevision: 1,
        },
      ],
    });
    expect(await semantic.search(query, new AbortController().signal)).toEqual(
      [],
    );
    await semantic.index();
    expect(
      (await semantic.search(query, new AbortController().signal))[0]?.metadata
        .revision,
    ).toBe(2);
    expect(await language.search(query, new AbortController().signal)).toEqual(
      [],
    );
    expect(
      (
        await db.sql.query(
          "SELECT DISTINCT role,model_identity FROM memory_native_vectors",
        )
      ).rows,
    ).toHaveLength(2);
    expect(await db.memoryGraph.listEdges({ nodeId: node.id })).toEqual([]);
  } finally {
    await db.close();
  }
});
