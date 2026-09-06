/**
 * 功能概述：用 PGlite 验证生产 MemoryStore 的幂等、冲突、范围过滤与稀疏排序。
 * 主要职责：覆盖全局检索、namespace/account/scope 组合、中英文和单字符路径。
 * 代码库关系：复用正式 migration 与 PostgresMemoryStore，不用内存替身掩盖 SQL 行为。
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
  await database.migrate();
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
    await expect(database.migrate()).resolves.toBeUndefined();
    await appendSource(database, "source-1", "2026-09-06T10:00:00.000Z");

    const first = await memory.put(input("source-1", "moonlight"));
    const replay = await memory.put(input("source-1", "moonlight"));

    expect(first.created).toBe(true);
    expect(replay).toEqual({ document: first.document, created: false });
    await expect(memory.put(input("source-1", "changed"))).rejects.toThrow(
      MemorySourceConflictError,
    );
  });

  it("ranks Unicode gram coverage before recency with deterministic ties", async () => {
    const { database, memory } = await setup();
    for (const [id, text, occurredAt] of [
      ["source-exact-old", "moonlight", "2026-09-06T08:00:00.000Z"],
      ["source-exact-new", "bright moonlight", "2026-09-06T09:00:00.000Z"],
      ["source-partial", "moon", "2026-09-06T10:00:00.000Z"],
      ["source-cn", "今晚的月亮很好看", "2026-09-06T11:00:00.000Z"],
    ] as const) {
      await appendSource(database, id, occurredAt);
      await memory.put(input(id, text, { occurredAt }));
    }

    const english = await memory.recall({ query: "moonlight", limit: 8 });
    expect(english.map((hit) => hit.document.sourceInformationId)).toEqual([
      "source-exact-new",
      "source-exact-old",
      "source-partial",
    ]);
    expect(english[0]!.score).toBe(1);

    expect(
      (await memory.recall({ query: "月亮", limit: 8 })).map(
        (hit) => hit.document.sourceInformationId,
      ),
    ).toEqual(["source-cn"]);
    expect(
      (await memory.recall({ query: "月", limit: 8 })).map(
        (hit) => hit.document.sourceInformationId,
      ),
    ).toEqual(["source-cn"]);
  });

  it("supports global recall and ANDs independently optional key dimensions", async () => {
    const { database, memory } = await setup();
    const documents = [
      input("source-a", "shared moon", {
        accountId: "account-1",
        destination: { kind: "group", groupId: "group-1" },
      }),
      input("source-b", "shared moon", {
        accountId: "account-2",
        destination: { kind: "group", groupId: "group-1" },
      }),
      input("source-c", "shared moon", {
        accountId: "account-1",
        destination: { kind: "group", groupId: "group-2" },
      }),
      input("source-d", "shared moon", {
        platform: "web",
        adapterId: "web.main",
        accountId: "web",
        destination: { kind: "web" },
      }),
    ];
    for (const document of documents) {
      await appendSource(
        database,
        document.sourceInformationId,
        document.occurredAt,
      );
      await memory.put(document);
    }

    expect(await sourceIds(memory, { query: "moon", limit: 10 })).toHaveLength(
      4,
    );
    expect(
      await sourceIds(memory, {
        query: "moon",
        accounts: [
          { platform: "qq", adapterId: "qq.main", accountId: "account-2" },
          { platform: "web", adapterId: "web.main", accountId: "web" },
        ],
        limit: 10,
      }),
    ).toEqual(["source-b", "source-d"]);
    expect(
      await sourceIds(memory, {
        query: "moon",
        accounts: [
          { platform: "qq", adapterId: "qq.main", accountId: "account-1" },
        ],
        limit: 10,
      }),
    ).toEqual(["source-a", "source-c"]);
    expect(
      await sourceIds(memory, {
        query: "moon",
        accounts: [
          { platform: "qq", adapterId: "qq.main", accountId: "account-1" },
        ],
        scopes: [
          {
            platform: "qq",
            adapterId: "qq.main",
            destination: { kind: "group", groupId: "group-1" },
          },
        ],
        limit: 10,
      }),
    ).toEqual(["source-a"]);
  });
});

async function sourceIds(
  memory: PostgresMemoryStore,
  query: Parameters<PostgresMemoryStore["recall"]>[0],
) {
  return (await memory.recall(query)).map(
    (hit) => hit.document.sourceInformationId,
  );
}
