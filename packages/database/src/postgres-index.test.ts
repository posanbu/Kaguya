/**
 * 功能概述：本测试覆盖 PostgreSQL 数据库入口与 append-only migration 触发器。
 * 主要职责：确认最终 `KaguyaDatabase.connect` 入口，以及直接 UPDATE/DELETE atom
 * 被数据库层拒绝；跨后端 ledger 行为已迁移至 `information-ledger.contract.ts`。
 * 代码库关系：这里直接消费 `createTestingDatabase()` 与最终 `KaguyaDatabase` 公开面；
 * PGlite 与真实 PostgreSQL 都通过共享 contract 验证 kind 同步、JSONB 与账本操作。
 * 输入输出与副作用：数据库行为在独立 PGlite 实例中执行；用例显式迁移并关闭实例，
 * 不读取环境连接串。
 */
import { describe, expect, it } from "vitest";

import { freezeInformationAtom, informationIdSchema, z } from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";

import { KaguyaDatabase } from "./index.js";
import { createTestingDatabase } from "./testing.js";

const TEST_TIMEOUT = 15_000;

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
