/**
 * 功能概述：验证浏览器会话在持久化观察范围与原生 Memory 召回中的隔离，不依赖异步 runner。
 * 主要职责：覆盖同会话连续消息、跨会话与旧匿名数据隔离、lifecycle 投影重建，以及旧 v1 Memory 约束兼容升级。
 * 代码库关系：通过 PGlite（或显式测试连接的 PostgreSQL）及仓储公共接口验证 SQL 语义，不以替身跳过约束。
 * 输入输出与副作用：每例创建隔离数据库，按完成 Promise 同步并在 finally 关闭；投影删除只作用于该测试数据库。
 */
import { expect, it } from "vitest";
import {
  freezeInformationAtom,
  informationIdSchema,
  type PlatformDestination,
} from "@kaguya/schema";
import {
  createPostgresTestingDatabase,
  createTestingDatabase,
} from "./testing.js";

const connectionString = process.env.KAGUYA_TEST_DATABASE_URL;
const createDatabase = connectionString
  ? () => createPostgresTestingDatabase(connectionString)
  : createTestingDatabase;

const conversationA = "a879c96e-afdd-4716-9b86-8d15d264907f";
const conversationB = "9f23283f-fe96-4fcf-9c27-13349329a353";
const occurredAt = "2026-09-19T00:00:00.000Z";
const kind = "core.message.inbound.text";

async function append(
  database: Awaited<ReturnType<typeof createTestingDatabase>>,
  id: string,
  destination: PlatformDestination,
) {
  await database.information.append(
    freezeInformationAtom({
      informationId: informationIdSchema.parse(id),
      kind,
      occurredAt,
      source: "runtime:ingress",
      payload: {
        text: "shared moon",
        source: { platform: "web", adapterId: "web.ui.main", destination },
      },
      references: [],
    }),
    [],
  );
}

it("isolates Web lifecycle scopes during append and projection rebuild", async () => {
  const database = await createDatabase();
  try {
    await database.prepareSchema();
    await database.information.synchronizeKinds([
      kind,
      "core.delivery.delivered",
    ]);
    await append(database, "a1", {
      kind: "web",
      conversationId: conversationA,
    });
    await append(database, "a2", {
      kind: "web",
      conversationId: conversationA,
    });
    await append(database, "b1", {
      kind: "web",
      conversationId: conversationB,
    });
    await append(database, "legacy", { kind: "web" });
    await database.information.append(
      freezeInformationAtom({
        informationId: informationIdSchema.parse("delivered-a"),
        kind: "core.delivery.delivered",
        occurredAt,
        source: "runtime:delivery",
        payload: {
          platform: "web",
          adapterId: "web.ui.main",
          target: { kind: "web", conversationId: conversationA },
          ok: true,
        },
        references: [],
      }),
      [],
    );

    const expectIsolation = async () => {
      for (const [conversationId, expected] of [
        [conversationA, ["a1", "a2"]],
        [conversationB, ["b1"]],
        ["", ["legacy"]],
      ] as const) {
        const atoms = await database.information.find({
          kinds: [kind],
          scopeKey: `web:web.ui.main:web:${conversationId}`,
          registrationOrder: true,
          order: "asc",
          limit: 10,
        });
        expect(atoms.map((atom) => atom.informationId)).toEqual(expected);
        const deliveries = await database.information.find({
          kinds: ["core.delivery.delivered"],
          scopeKey: `web:web.ui.main:web:${conversationId}`,
          registrationOrder: true,
          limit: 10,
        });
        expect(deliveries.map((atom) => atom.informationId)).toEqual(
          conversationId === conversationA ? ["delivered-a"] : [],
        );
      }
    };
    await expectIsolation();
    await database.sql.exec(`
      DROP TABLE information_scope_heads;
      DROP TABLE information_lifecycle;
      DROP INDEX information_atoms_scope_time_idx;
    `);
    await database.prepareSchema();
    await expectIsolation();
  } finally {
    await database.close();
  }
}, 15_000);

it("upgrades the old Web memory constraint and recalls each conversation independently", async () => {
  const database = await createDatabase();
  try {
    await database.prepareSchema();
    await database.information.synchronizeKinds([kind]);
    await database.sql.exec(`
      ALTER TABLE memory_documents
        DROP CONSTRAINT memory_documents_destination_check,
        ADD CONSTRAINT memory_documents_check CHECK (
          (destination_kind = 'web' AND destination_id IS NULL)
          OR (destination_kind IN ('private', 'group') AND destination_id IS NOT NULL)
        );
    `);
    const put = async (id: string, destination: PlatformDestination) => {
      await append(database, id, destination);
      return database.memory.put({
        sourceInformationId: id,
        sourceKind: kind,
        content: "shared moon",
        occurredAt,
        address: {
          platform: "web",
          adapterId: "web.ui.main",
          accountId: "same-account-to-isolate-scope-filter",
          platformMessageId: `request-${id}`,
          destination,
        },
      });
    };
    const legacy = await put("legacy-memory", { kind: "web" });
    await database.prepareSchema();
    await database.prepareSchema();
    const a = await put("a-memory", {
      kind: "web",
      conversationId: conversationA,
    });
    const b = await put("b-memory", {
      kind: "web",
      conversationId: conversationB,
    });
    for (const expected of [legacy.document, a.document, b.document]) {
      const hits = await database.memory.recall({
        query: "moon",
        limit: 10,
        scopes: [
          {
            platform: "web",
            adapterId: "web.ui.main",
            destination: expected.address.destination,
          },
        ],
      });
      expect(hits.map((hit) => hit.document)).toEqual([expected]);
    }
    await expect(
      database.sql.query(
        "UPDATE memory_documents SET destination_kind='private', destination_id=NULL WHERE memory_id=$1",
        [legacy.document.memoryId],
      ),
    ).rejects.toThrow();
  } finally {
    await database.close();
  }
}, 15_000);
