/**
 * 功能概述：用真实 pgvector WASM 扩展验证 SQL 向量投影、身份隔离与 scoped hybrid recall。
 * create 在独立 PGlite 中安装扩展，put 构造 canonical 文档；测试覆盖幂等、维度/revision 切换、
 * dense-only 命中、跨群/账号过滤和 provider 故障降级。afterEach 只关闭本测试数据库。
 * 双时间测试使用真实 hybrid 路径，确保 dense-only 候选同样不能绕过原文入库截止点。
 */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { HybridMemoryRecall } from "@kaguya/memory";
import { afterEach, describe, expect, it } from "vitest";
import { KaguyaDatabase } from "./index.js";
import { PGliteDatabase } from "./pglite-driver.js";
import { PostgresMemoryVectorIndex } from "./memory-vector.js";
import { inspectMemoryVectors } from "./memory-inspection.js";
const databases: KaguyaDatabase[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
});
const identity = { modelId: "test", revision: "v1", dimensions: 2 };
async function create() {
  const database = new KaguyaDatabase(
    new PGliteDatabase(await PGlite.create({ extensions: { vector } })),
  );
  databases.push(database);
  await database.prepareSchema();
  const index = new PostgresMemoryVectorIndex(database.sql);
  await index.prepare();
  async function put(id: string, groupId = "allowed", accountId = "user") {
    await database.sql.query(
      "INSERT INTO information_kinds(kind) VALUES ('core.message.inbound.text') ON CONFLICT DO NOTHING",
    );
    await database.sql.query(
      "INSERT INTO information_atoms(information_id,kind,occurred_at,source,payload) VALUES ($1,'core.message.inbound.text','2026-09-01T00:00:00.000Z','test','{}')",
      [id],
    );
    return (
      await database.memory.put({
        sourceInformationId: id,
        sourceKind: "core.message.inbound.text",
        content: id,
        occurredAt: "2026-09-01T00:00:00.000Z",
        address: {
          platform: "qq",
          adapterId: "qq.main",
          platformMessageId: id,
          accountId,
          destination: { kind: "group", groupId },
        },
      })
    ).document;
  }
  return { database, index, put };
}
describe("Memory pgvector projection", () => {
  it("inspects actual index metadata with stable composite pagination and no vector contents", async () => {
    const f = await create();
    const doc = await f.put("inspection-source");
    await f.index.putVector(doc.memoryId, identity, [1, 0]);
    await f.index.putVector(
      doc.memoryId,
      { ...identity, revision: "v2" },
      [0, 1],
    );
    const first = await inspectMemoryVectors(f.database.sql, { limit: 1 });
    expect(first.available).toBe(true);
    expect(first.items).toEqual([
      {
        memoryId: doc.memoryId,
        sourceInformationId: "inspection-source",
        ...identity,
      },
    ]);
    const second = await inspectMemoryVectors(f.database.sql, {
      limit: 1,
      cursor: first.items[0]!,
    });
    expect(second.items[0]?.revision).toBe("v2");
    expect(
      await inspectMemoryVectors(f.database.sql, {
        limit: 1,
        cursor: second.items[0]!,
      }),
    ).toEqual({ available: true, items: [] });
    expect(JSON.stringify(first)).not.toContain("embedding");
    expect(
      (await f.database.sql.query("SELECT * FROM memory_document_vectors"))
        .rows,
    ).toHaveLength(2);
  });
  it("isolates model, revision and dimensions and replays idempotently", async () => {
    const f = await create();
    const doc = await f.put("coffee");
    await f.index.putVector(doc.memoryId, identity, [1, 0]);
    await f.index.putVector(doc.memoryId, identity, [1, 0]);
    const q = { query: "tea", limit: 10 };
    expect(await f.index.recallVector(q, identity, [1, 0])).toHaveLength(1);
    expect(
      await f.index.recallVector(q, { ...identity, revision: "v2" }, [1, 0]),
    ).toEqual([]);
    expect(
      await f.index.recallVector(q, { ...identity, modelId: "other" }, [1, 0]),
    ).toEqual([]);
    expect(
      await f.index.recallVector(q, { ...identity, dimensions: 3 }, [1, 0, 0]),
    ).toEqual([]);
    expect(
      (await f.database.sql.query("SELECT * FROM memory_document_vectors"))
        .rows,
    ).toHaveLength(1);
    await expect(
      f.index.putVector(doc.memoryId, identity, [1]),
    ).rejects.toThrow("Invalid embedding");
  });
  it("includes dense-only candidates within identical scope/account filters and falls back to sparse", async () => {
    const f = await create();
    const allowed = await f.put("coffee");
    const outside = await f.put("coffee-other", "other");
    const wrongUser = await f.put("coffee-account", "allowed", "other");
    for (const doc of [allowed, outside, wrongUser])
      await f.index.putVector(doc.memoryId, identity, [1, 0]);
    const query = {
      query: "tea",
      limit: 10,
      scopes: [
        {
          platform: "qq",
          adapterId: "qq.main",
          destination: { kind: "group" as const, groupId: "allowed" },
        },
      ],
      accounts: [{ platform: "qq", adapterId: "qq.main", accountId: "user" }],
    };
    const hybrid = new HybridMemoryRecall(f.database.memory, f.index, {
      identity,
      embed: async () => [1, 0],
    });
    expect(
      (await hybrid.recall(query)).map((hit) => hit.document.memoryId),
    ).toEqual([allowed.memoryId]);
    expect(
      await hybrid.recall({
        ...query,
        excludeSourceInformationIds: [allowed.sourceInformationId],
      }),
    ).toEqual([]);
    const failed = new HybridMemoryRecall(f.database.memory, f.index, {
      identity,
      embed: async () => {
        throw new Error("provider secret");
      },
    });
    expect(await failed.recall({ ...query, query: "coffee" })).toEqual(
      await f.database.memory.recall({ ...query, query: "coffee" }),
    );
  });
  it("paginates canonical documents without offset loss", async () => {
    const f = await create();
    for (const id of ["one", "two", "three"]) await f.put(id);
    const first = await f.database.memory.listDocuments({ limit: 2 });
    const next = await f.database.memory.listDocuments({
      limit: 2,
      afterMemoryId: first[1]!.memoryId,
    });
    expect(new Set([...first, ...next].map((doc) => doc.memoryId)).size).toBe(
      3,
    );
    expect(await f.database.memory.getBySource("one")).toMatchObject({
      sourceInformationId: "one",
    });
  });
  it("applies the same recording cutoff to dense-only and sparse candidates", async () => {
    const f = await create();
    const doc = await f.put("coffee");
    await f.index.putVector(doc.memoryId, identity, [1, 0]);
    const hybrid = new HybridMemoryRecall(f.database.memory, f.index, {
      identity,
      embed: async () => [1, 0],
    });
    const beforeRecording = new Date(
      Date.parse(doc.createdAt) - 1,
    ).toISOString();
    for (const query of ["tea", "coffee"]) {
      await expect(
        hybrid.recall({
          query,
          occurredBefore: "2026-09-02T00:00:00.000Z",
          recordedBefore: beforeRecording,
          limit: 8,
        }),
      ).resolves.toEqual([]);
      expect(
        (
          await hybrid.recall({
            query,
            occurredBefore: "2026-09-02T00:00:00.000Z",
            recordedBefore: doc.createdAt,
            limit: 8,
          })
        ).map((hit) => hit.document.memoryId),
      ).toEqual([doc.memoryId]);
    }
  });
});
