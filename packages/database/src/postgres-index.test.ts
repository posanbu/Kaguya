/**
 * 功能概述：本测试覆盖 PostgreSQL 版数据库入口、迁移守卫与测试辅助器，
 * 目标是在正式实现前先锁定“可迁移、可执行 SQL、可按 kind 同步”的公共边界。
 * 主要职责：确认最终 `KaguyaDatabase.connect` 入口、kind 集合守卫、JSONB 往返和
 * atom UPDATE/DELETE 触发器约束。
 * 代码库关系：这里直接消费 `createTestingDatabase()` 与最终 `KaguyaDatabase`
 * 公开面，并使用真实 SQL 断言 append-only 约束、kind 同步和 JSONB 往返行为。
 * 输入输出与副作用：数据库行为在独立 PGlite 实例中执行；用例显式迁移并关闭实例，
 * 不读取环境连接串。
 */
import { describe, expect, it } from "vitest";

import { freezeInformationAtom, informationIdSchema, z } from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";

import { InformationStoreError, KaguyaDatabase } from "./index.js";
import { createTestingDatabase } from "./testing.js";

const TEST_TIMEOUT = 15_000;

const contextKind = defineInformationKind({
  kind: "core.runtime.context",
  payloadSchema: z.object({ name: z.string() }).strict(),
  references: {},
  log: { enabled: false },
});

const inboundKind = defineInformationKind({
  kind: "core.message.inbound.text",
  payloadSchema: z.object({ text: z.string() }).strict(),
  references: {
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: [contextKind.kind],
    },
  },
  log: { enabled: false },
});

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
    "rejects a mismatched synchronized kind set",
    async () => {
      const database = await createTestingDatabase();
      await database.migrate();

      await database.information.synchronizeKinds([contextKind.kind]);

      await expect(
        database.information.synchronizeKinds([
          contextKind.kind,
          inboundKind.kind,
        ]),
      ).rejects.toBeInstanceOf(InformationStoreError);

      await database.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "round-trips payloads through JSONB",
    async () => {
      const database = await createTestingDatabase();
      await database.migrate();
      await database.information.synchronizeKinds([plainKind.kind]);

      const atom = freezeInformationAtom({
        informationId: informationIdSchema.parse("atom-jsonb"),
        kind: plainKind.kind,
        occurredAt: "2026-09-01T00:00:00.000Z",
        source: "module:test",
        payload: { nested: { values: ["moon", "light"] } },
        references: [],
      });

      await database.information.append(atom, []);

      const result = await database.sql.query<{ payload: unknown }>(
        "SELECT payload FROM information_atoms WHERE information_id = $1",
        [atom.informationId],
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.payload).toEqual(atom.payload);

      await database.close();
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
