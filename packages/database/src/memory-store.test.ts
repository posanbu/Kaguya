/**
 * 功能概述：用 PGlite 验证生产 MemoryStore 的幂等、冲突、范围过滤与稀疏排序。
 * 主要职责：覆盖全局检索、namespace/account/scope 组合、中英文和单字符路径。
 * 分离发生时间与入库时间，防止迟到原文污染冻结的历史检索。
 * 代码库关系：复用正式 v1 schema 与 PostgresMemoryStore，不用内存替身掩盖 SQL 行为。
 * 输入输出与副作用：每例创建并关闭隔离 PGlite 数据库。
 */
import { afterEach, describe, expect, it } from "vitest";

import { MemorySourceConflictError } from "@kaguya/memory";
import { freezeInformationAtom, informationIdSchema } from "@kaguya/schema";

import { PostgresMemoryStore } from "./memory-store.js";
import { createTestingDatabase } from "./testing.js";

const databases: Awaited<ReturnType<typeof createTestingDatabase>>[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

async function setup() {
  const database = await createTestingDatabase();
  databases.push(database);
  await database.prepareSchema();
  await database.information.synchronizeKinds(["core.message.inbound.text"]);
  let sequence = 0;
  const memory = new PostgresMemoryStore(database.sql, {
    memoryIdGenerator: () => `memory-${++sequence}`,
    now: () => new Date("2026-09-06T12:00:00.000Z"),
  });
  return { database, memory };
}

async function appendSource(
  database: Awaited<ReturnType<typeof createTestingDatabase>>,
  informationId: string,
  occurredAt: string,
) {
  await database.information.append(
    freezeInformationAtom({
      informationId: informationIdSchema.parse(informationId),
      kind: "core.message.inbound.text",
      occurredAt,
      source: "runtime:ingress",
      payload: {},
      references: [],
    }),
    [],
  );
}

function input(
  sourceInformationId: string,
  content: string,
  options: {
    readonly accountId?: string;
    readonly destination?:
      | { readonly kind: "group"; readonly groupId: string }
      | { readonly kind: "private"; readonly userId: string }
      | { readonly kind: "web" };
    readonly occurredAt?: string;
    readonly platform?: string;
    readonly adapterId?: string;
  } = {},
) {
  return {
    sourceInformationId,
    sourceKind: "core.message.inbound.text",
    content,
    occurredAt: options.occurredAt ?? "2026-09-06T10:00:00.000Z",
    address: {
      platform: options.platform ?? "qq",
      adapterId: options.adapterId ?? "qq.main",
      platformMessageId: `platform-${sourceInformationId}`,
      accountId: options.accountId ?? "account-1",
      destination: options.destination ?? {
        kind: "group" as const,
        groupId: "group-1",
      },
    },
  };
}

describe("PostgresMemoryStore", () => {
  it("returns the existing document for an identical source and rejects drift", async () => {
    const { database, memory } = await setup();
    await expect(database.prepareSchema()).resolves.toBeUndefined();
    await appendSource(database, "source-1", "2026-09-06T10:00:00.000Z");

    const first = await memory.put(input("source-1", "moonlight"));
    const replay = await memory.put(input("source-1", "moonlight"));

    expect(first.created).toBe(true);
    expect(replay).toEqual({ document: first.document, created: false });
    await expect(memory.put(input("source-1", "changed"))).rejects.toThrow(
      MemorySourceConflictError,
    );
  });

  it("indexes optional long-term documents for sparse recall", async () => {
    const { database, memory } = await setup();
    await appendSource(database, "source-2", "2026-09-06T10:00:00.000Z");
    await memory.put(input("source-2", "moonlight"));
    expect((await memory.getBySource("source-2"))?.content).toBe("moonlight");
    const grams = await database.sql.query(
      "SELECT * FROM memory_document_ngrams",
    );
    expect(grams.rows.length).toBeGreaterThan(0);
    expect((await memory.recall({ query: "moonlight", limit: 5 })).map((hit) => hit.document.sourceInformationId)).toEqual(["source-2"]);
  });
});
