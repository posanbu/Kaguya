/**
 * 功能概述：本测试覆盖 PostgreSQL 数据库入口、append-only migration 触发器与真实服务器索引。
 * 主要职责：确认最终 `KaguyaDatabase.connect` 入口，以及直接 UPDATE/DELETE atom
 * 被数据库层拒绝；跨后端 ledger 行为已迁移至 `information-ledger.contract.ts`。
 * 代码库关系：PGlite 用例消费 `createTestingDatabase()`；真实 PostgreSQL 用例消费
 * `createPostgresTestingDatabase()`，并由根 `test:postgres` 命令执行。共享 contract 验证账本行为。
 * 输入输出与副作用：每个用例创建、迁移并关闭独立测试库；真实服务器 schema 会由 factory 清理。
 */
import { describe, expect, it } from "vitest";

import { freezeInformationAtom, informationIdSchema, z } from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";

import { KaguyaDatabase } from "./index.js";
import {
  createPostgresTestingDatabase,
  createTestingDatabase,
} from "./testing.js";

const TEST_TIMEOUT = 15_000;
const connectionString = process.env.KAGUYA_TEST_DATABASE_URL;
const requirePostgres = process.env.KAGUYA_REQUIRE_POSTGRES_TESTS === "1";

if (requirePostgres && connectionString === undefined) {
  throw new Error(
    "KAGUYA_TEST_DATABASE_URL is required when PostgreSQL migration tests are required",
  );
}

const describePostgres =
  connectionString === undefined ? describe.skip : describe;

const plainKind = defineInformationKind({
  kind: "core.runtime.snapshot",
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

describe("KaguyaDatabase", () => {
  it(
    "exposes the final PostgreSQL connection entry",
    () => {
      expect(typeof KaguyaDatabase.connect).toBe("function");
    },
    TEST_TIMEOUT,
  );

  it(
    "rejects direct UPDATE and DELETE statements on stored atoms",
    async () => {
      const database = await createTestingDatabase();
      await database.migrate();
      await database.information.synchronizeKinds([plainKind.kind]);

      const atom = freezeInformationAtom({
        informationId: informationIdSchema.parse("atom-locked"),
        kind: plainKind.kind,
        occurredAt: "2026-09-01T00:00:00.000Z",
        source: "module:test",
        payload: { nested: { values: ["moon"] } },
        references: [],
      });

      await database.information.append(atom, []);

      await expect(
        database.sql.exec(
          "UPDATE information_atoms SET kind = 'core.runtime.changed' WHERE information_id = 'atom-locked'",
        ),
      ).rejects.toThrow(/append-only/i);

      await expect(
        database.sql.exec(
          "DELETE FROM information_atoms WHERE information_id = 'atom-locked'",
        ),
      ).rejects.toThrow(/append-only/i);

      await database.close();
    },
    TEST_TIMEOUT,
  );
});

describePostgres("KaguyaDatabase migrations (PostgreSQL)", () => {
  it(
    "creates the required kind, time, and reference indexes on PostgreSQL",
    async () => {
      const database = await createPostgresTestingDatabase(connectionString!);
      try {
        await database.migrate();
        const indexes = await database.sql.query<{
          indexname: string;
          indexdef: string;
        }>(
          `SELECT indexname, indexdef
           FROM pg_indexes
           WHERE schemaname = current_schema()
             AND tablename = ANY($1::text[])`,
          [
            [
              "information_atoms",
              "information_references",
              "information_log_outbox",
            ],
          ],
        );
        const definitions = new Map(
          indexes.rows.map((index) => [index.indexname, index.indexdef]),
        );

        expect(
          definitions.get("information_atoms_kind_occurred_at_idx"),
        ).toMatch(/\(kind, occurred_at, information_id\)/i);
        expect(
          definitions.get("information_atoms_source_occurred_at_idx"),
        ).toMatch(/\(source, occurred_at, information_id\)/i);
        expect(
          definitions.get("information_references_target_relation_idx"),
        ).toMatch(
          /\(target_information_id, relation, information_id, ordinal\)/i,
        );
        expect(definitions.get("information_log_outbox_pending_idx")).toMatch(
          /\(attempt_count, created_at, information_id\).*projected_at IS NULL/i,
        );
      } finally {
        await database.close();
      }
    },
    TEST_TIMEOUT,
  );
});
