/**
 * 功能概述：在真实 PostgreSQL 上验证 Memory schema、幂等写入与稀疏召回。
 * 主要职责：防止 PGlite 与生产 SQL 在数组、时区或约束语义上产生偏差。
 * 代码库关系：由根 test:postgres 显式执行，测试工厂提供隔离 schema。
 * 输入输出与副作用：需要 KAGUYA_TEST_DATABASE_URL；测试结束删除临时 schema。
 */
import { describe, expect, it } from "vitest";

import { freezeInformationAtom, informationIdSchema } from "@kaguya/schema";

import { createPostgresTestingDatabase } from "./testing.js";

const connectionString = process.env.KAGUYA_TEST_DATABASE_URL;
const requirePostgres = process.env.KAGUYA_REQUIRE_POSTGRES_TESTS === "1";
if (requirePostgres && connectionString === undefined)
  throw new Error("KAGUYA_TEST_DATABASE_URL is required for PostgreSQL tests");
const describePostgres =
  connectionString === undefined ? describe.skip : describe;

describePostgres("PostgresMemoryStore", () => {
  it("writes idempotently and recalls through the production indexes", async () => {
    const database = await createPostgresTestingDatabase(connectionString!);
    try {
      await database.prepareSchema();
      await database.information.synchronizeKinds([
        "core.message.inbound.text",
      ]);
      await database.information.append(
        freezeInformationAtom({
          informationId: informationIdSchema.parse("source-pg"),
          kind: "core.message.inbound.text",
          occurredAt: "2026-09-06T10:00:00.000Z",
          source: "runtime:ingress",
          payload: {},
          references: [],
        }),
        [],
      );
      const input = {
        sourceInformationId: "source-pg",
        sourceKind: "core.message.inbound.text",
        content: "PostgreSQL moon memory",
        occurredAt: "2026-09-06T10:00:00.000Z",
        address: {
          platform: "qq",
          adapterId: "qq.main",
          platformMessageId: "message-pg",
          accountId: "account-pg",
          destination: { kind: "group" as const, groupId: "group-pg" },
        },
      };
      expect((await database.memory.put(input)).created).toBe(true);
      expect((await database.memory.put(input)).created).toBe(false);
      expect(
        (await database.memory.recall({ query: "moon", limit: 8 }))[0]?.document
          .sourceInformationId,
      ).toBe("source-pg");
    } finally {
      await database.close();
    }
  });
});
